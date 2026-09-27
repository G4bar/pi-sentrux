import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { buildInvocationArgs } from "./binary.ts";
import type { CliCommand } from "./cli.ts";
import { capThrownMessage } from "./format.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Tools sentrux_* (Phase 4) depend on; missing any of these makes the server unusable. */
export const REQUIRED_MCP_TOOLS = ["scan", "health", "session_start", "session_end", "dsm", "test_gaps", "git_stats"] as const;

const DEFAULT_START_TIMEOUT_MS = 300_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_CHARS = 8 * 1024;
const DEFAULT_CLOSE_SIGTERM_DELAY_MS = 2000;
const DEFAULT_CLOSE_SIGKILL_DELAY_MS = 1000;

export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/** The subset of McpClient's contract the server registry (and tests) depend on. */
export interface McpClientLike {
  readonly isAlive: boolean;
  /** Increments each time the underlying process is (re)spawned; 0 for the first spawn. */
  readonly generation: number;
  /** For observability/testing only; undefined before the first spawn. */
  readonly pid: number | undefined;
  start(): Promise<void>;
  callTool<T = unknown>(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  close(): Promise<void>;
  /** Synchronous best-effort kill for a `process.once("exit", ...)` safety net. */
  forceKillSync(): void;
}

export interface McpClientOptions {
  /** Resolved lazily at spawn time so the binary path/config can still change before first use. */
  resolveCommand: () => CliCommand | Promise<CliCommand>;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  closeSigtermDelayMs?: number;
  closeSigkillDelayMs?: number;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type SentruxChild = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * One `<bin> mcp` process per instance. The server is single-threaded, so requests
 * are serialized through a promise-chain queue; it also cannot cancel an in-flight
 * request, so a timeout or abort kills the whole process instead.
 */
export class McpClient implements McpClientLike {
  private child: SentruxChild | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuf = "";
  private stderrTail = "";
  private dead = true;
  private exitReason = "not started";
  private queue: Promise<unknown> = Promise.resolve();
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  /** Bumped by every close() so a start() that is still awaiting resolveCommand
   * can notice it was closed and skip spawning a process nobody tracks. A generation
   * counter rather than a permanent flag: evicted clients respawn on purpose. */
  private startEpoch = 0;
  private generationCounter = -1;
  serverInfo: { name: string; version: string; protocolVersion: string } | undefined;

  constructor(private readonly options: McpClientOptions) {}

  get isAlive(): boolean {
    return this.child !== undefined && !this.dead;
  }

  get generation(): number {
    return this.generationCounter;
  }

  /** For observability/testing only; undefined before the first spawn. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    if (this.isAlive && this.serverInfo) return;
    if (!this.startPromise) {
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const epoch = this.startEpoch;
    const cli = await this.options.resolveCommand();
    if (epoch !== this.startEpoch) {
      // close() ran while resolveCommand was in flight; doClose already returned
      // without a child to kill, so spawning now would leak an untracked process.
      this.dead = true;
      this.exitReason = "closed during start";
      throw new Error("sentrux mcp client was closed during start");
    }
    this.spawnChild(cli);
    const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

    const initResult = (await this.enqueueRequest(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pi-sentrux", version: this.options.clientVersion },
      },
      startTimeoutMs,
    )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } } | undefined;

    this.serverInfo = {
      name: initResult?.serverInfo?.name ?? "unknown",
      version: initResult?.serverInfo?.version ?? "unknown",
      protocolVersion: initResult?.protocolVersion ?? "unknown",
    };
    if (initResult?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      console.error(
        `pi-sentrux: MCP server reported protocolVersion "${initResult?.protocolVersion}", expected "${MCP_PROTOCOL_VERSION}"; continuing.`,
      );
    }

    this.sendNotification("notifications/initialized", {});

    const toolsResult = (await this.enqueueRequest("tools/list", {}, startTimeoutMs)) as { tools?: { name: string }[] } | undefined;
    const names = new Set((toolsResult?.tools ?? []).map((t) => t.name));
    for (const tool of REQUIRED_MCP_TOOLS) {
      if (!names.has(tool)) {
        const err = this.withStderr(new Error(`Sentrux ${this.serverInfo.version} lacks MCP tool ${tool}`));
        this.hardKill();
        throw err;
      }
    }
  }

  private spawnChild(cli: CliCommand): void {
    const args = [...(cli.prefixArgs ?? []), ...buildInvocationArgs("mcp")];
    const child = spawn(cli.command, args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.dead = false;
    this.exitReason = "not started";
    this.stdoutBuf = "";
    this.stderrTail = "";
    this.closePromise = undefined;
    this.generationCounter += 1;

    child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    // An EPIPE/EIO on a dead child's stdin arrives as an async 'error' event, which the
    // try/catch around stdin.write cannot catch; without this listener pi terminates on an
    // uncaught exception. Route it into the normal child-down path instead.
    child.stdin.on("error", (err) => {
      if (this.child !== child) return; // a stale event from a process already replaced by a respawn
      this.onChildDown(`stdin error: ${(err as Error).message}`);
    });
    // No-op error handlers so a stream error on a dying child never throws uncaught.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.once("error", (err) => {
      if (this.child !== child) return; // a stale event from a process already replaced by a respawn
      this.onChildDown(`spawn error: ${(err as Error).message}`);
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) return; // a stale event from a process already replaced by a respawn
      this.onChildDown(`exited code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`);
    });
  }

  private onStdoutData(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const rawLine = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.hardKill();
        return;
      }
      this.handleLine(line);
    }
    if (Buffer.byteLength(this.stdoutBuf, "utf8") > MAX_LINE_BYTES) {
      this.hardKill();
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON line: ignored (no debug ring kept, since nothing reads it back in this phase)
    }
    if (msg.id === undefined) return; // a notification from the server; nothing to correlate
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(this.withStderr(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`)));
    } else {
      pending.resolve(msg.result);
    }
  }

  private withStderr(err: Error): Error {
    if (this.stderrTail) err.message += `\nstderr (tail): ${this.stderrTail}`;
    // The host surfaces error.message verbatim, so cap it: otherwise the stderr
    // tail alone could hand the model far more than maxOutputBytes.
    err.message = capThrownMessage(err.message);
    return err;
  }

  private onChildDown(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.exitReason = reason;
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pendingEntries) {
      entry.reject(this.withStderr(new Error(reason)));
    }
  }

  private hardKill(): void {
    if (!this.child) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.child || this.dead) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // stdin already closed; the pending handshake request will time out and surface the failure
    }
  }

  private enqueueRequest(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const task = this.queue.then(
      () => this.sendRequest(method, params, timeoutMs, signal),
      () => this.sendRequest(method, params, timeoutMs, signal),
    );
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.child || this.dead) {
      return Promise.reject(this.withStderr(new Error(`sentrux mcp process is not running (${this.exitReason})`)));
    }
    const id = this.nextId++;
    const child = this.child;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        action();
      };

      const onAbort = () => {
        finish(() => reject(this.withStderr(new Error(`sentrux mcp: ${method} aborted`))));
        this.killForTimeoutOrAbort();
      };

      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (err) => finish(() => reject(err)),
      });

      timer = setTimeout(() => {
        finish(() => reject(this.withStderr(new Error(`sentrux mcp: ${method} timed out after ${timeoutMs}ms`))));
        this.killForTimeoutOrAbort();
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        // The listener above never fires for an already-aborted signal; handle it now.
        onAbort();
      }

      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`);
      } catch (err) {
        finish(() => reject(this.withStderr(err as Error)));
      }
    });
  }

  /** Sentrux cannot cancel a single in-flight request, so the whole process is killed;
   * the registry respawns it (generation+1) on the next call, invalidating any baseline. */
  private killForTimeoutOrAbort(): void {
    this.onChildDown(this.exitReason !== "not started" ? this.exitReason : "killed after timeout/abort");
    this.hardKill();
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    await this.start();
    const timeoutMs = opts.timeoutMs ?? this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const result = (await this.enqueueRequest("tools/call", { name, arguments: args }, timeoutMs, opts.signal)) as
      | { content?: { type: string; text?: string }[]; isError?: boolean }
      | undefined;

    if (result?.isError) {
      const text = result.content?.[0]?.text ?? "";
      throw new McpToolError(this.withStderr(new Error(text)).message);
    }
    const text = result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text) as T;
      } catch {
        // SAFETY: per §6.2, callTool falls back to the raw text when it isn't JSON; the caller's T reflects that contract.
        return text as unknown as T;
      }
    }
    // SAFETY: only reached for a malformed/shapeless tools/call result; callers own the expected T for the tool they invoked.
    return result as T;
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.doClose();
    }
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    const child = this.child;
    this.startEpoch += 1;
    this.dead = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    const sigtermDelayMs = this.options.closeSigtermDelayMs ?? DEFAULT_CLOSE_SIGTERM_DELAY_MS;
    const sigkillDelayMs = this.options.closeSigkillDelayMs ?? DEFAULT_CLOSE_SIGKILL_DELAY_MS;

    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(sigtermTimer);
        clearTimeout(sigkillTimer);
        resolve();
      };
      child.once("exit", finish);

      const sigtermTimer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }, sigtermDelayMs);
      const sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, sigtermDelayMs + sigkillDelayMs);

      try {
        child.stdin.end();
      } catch {
        // stdin already closed; fall through to the SIGTERM/SIGKILL timers
      }
    });
  }

  forceKillSync(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}
