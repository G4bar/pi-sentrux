import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_ESCALATION_MS = 1000;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function capturingWriter(maxOutputBytes: number): { push: (chunk: Buffer) => void; text: () => string } {
  let text = "";
  let bytes = 0;
  return {
    push(chunk: Buffer) {
      if (bytes >= maxOutputBytes) return;
      const remaining = maxOutputBytes - bytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      text += slice.toString("utf8");
      bytes += slice.length;
    },
    text: () => text,
  };
}

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = capturingWriter(maxOutputBytes);
    const stderr = capturingWriter(maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killing = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    function killEscalating(): void {
      if (killing) return;
      killing = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, KILL_ESCALATION_MS);
    }

    function cleanup(): void {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    function onAbort(): void {
      aborted = true;
      killEscalating();
    }

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killEscalating();
      }, options.timeoutMs);
    }
    if (options.signal?.aborted) {
      // An already-aborted signal never fires the listener below; act on it now.
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout: stdout.text(), stderr: stderr.text(), timedOut, aborted });
    });
  });
}
