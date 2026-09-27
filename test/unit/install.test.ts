import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTelemetryOptOut,
  formatUnsupportedPlatformMessage,
  getReleaseEntry,
  installBinary,
  installTargetPath,
  RELEASE_TABLE,
  type ReleaseEntry,
} from "../../extensions/sentrux/install.ts";

const PAYLOAD = Buffer.from("#!/bin/sh\necho sentrux-0.5.7-test\n");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const TEST_ENTRY: ReleaseEntry = {
  asset: "sentrux-test-asset",
  sha256: PAYLOAD_SHA,
  url: "https://example.invalid/sentrux-test-asset",
};

function fetchOk(): (url: string) => Promise<Response> {
  return async () => new Response(PAYLOAD);
}

function versionRun(stdout = "sentrux 0.5.7\n") {
  return async () => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
}

describe("installBinary (injected fetch, no real network)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sentrux-install-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("installs on a matching sha: atomic rename, chmod +x, --version validation", async () => {
    const result = await installBinary({
      agentDir: dir,
      entry: TEST_ENTRY,
      fetchFn: fetchOk(),
      run: versionRun(),
    });

    expect(result.path).toBe(installTargetPath(dir));
    expect(result.version).toBe("sentrux 0.5.7");
    expect(await readFile(result.path)).toEqual(PAYLOAD);
    // chmod +x
    const mode = (await stat(result.path)).mode & 0o777;
    expect(mode & 0o111).toBeGreaterThan(0);
    // atomic rename: no temp files left behind in the target dir
    const leftovers = (await readdir(join(dir, "pi-sentrux", "bin"))).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("rejects a checksum mismatch and cleans up the temp file", async () => {
    const badEntry: ReleaseEntry = { ...TEST_ENTRY, sha256: "00".repeat(32) };
    await expect(
      installBinary({ agentDir: dir, entry: badEntry, fetchFn: fetchOk(), run: versionRun() }),
    ).rejects.toThrow(/checksum mismatch \(expected .*?, got .*?\)/);

    // Neither the target nor any temp file may remain.
    const binDir = join(dir, "pi-sentrux", "bin");
    const files = await readdir(binDir).catch(() => []);
    expect(files).toEqual([]);
  });

  it("a mid-download failure over an existing install removes the temp file and keeps the target", async () => {
    const target = installTargetPath(dir);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "old-binary");
    // The connection drops mid-stream: an error the old cleanup regex did not match,
    // which used to leave the partial temp file behind when a target already existed.
    const resetFetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial-bytes"));
            controller.error(new Error("connection reset"));
          },
        }),
      );
    await expect(
      installBinary({ agentDir: dir, entry: TEST_ENTRY, fetchFn: resetFetch, run: versionRun() }),
    ).rejects.toThrow(/connection reset/);

    // The previous install is untouched and no partial temp file is left behind.
    expect(await readFile(target, "utf8")).toBe("old-binary");
    const files = await readdir(dirname(target));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("rejects an unsupported platform and suggests Homebrew or cargo", async () => {
    await expect(installBinary({ agentDir: dir, platform: "darwin", arch: "x64" })).rejects.toThrow(
      /no release asset for darwin-x64/,
    );
    expect(formatUnsupportedPlatformMessage("darwin", "x64")).toMatch(/brew install sentrux\/tap\/sentrux/);
    expect(formatUnsupportedPlatformMessage("darwin", "x64")).toMatch(/cargo/);
    expect(getReleaseEntry("darwin", "x64")).toBeUndefined();
  });

  it("rejects an HTTP failure without installing anything", async () => {
    const fetchFail = async () => new Response("nope", { status: 404 });
    await expect(
      installBinary({ agentDir: dir, entry: TEST_ENTRY, fetchFn: fetchFail, run: versionRun() }),
    ).rejects.toThrow(/HTTP 404/);
    const files = await readdir(join(dir, "pi-sentrux", "bin")).catch(() => []);
    expect(files).toEqual([]);
  });

  it("aborts the download when the caller's signal fires", async () => {
    const controller = new AbortController();
    const hangingFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason instanceof Error ? init.signal.reason : new Error("aborted"));
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason instanceof Error ? init.signal!.reason : new Error("aborted")), { once: true });
      });
    const pending = installBinary({
      agentDir: dir,
      entry: TEST_ENTRY,
      fetchFn: hangingFetch,
      run: versionRun(),
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    // Let installBinary reach its fetch (the mkdir await yields first).
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow(/user cancelled/);
  });

  it("pins the real v0.5.7 table (linux-x86_64 digest matches the release page)", () => {
    expect(RELEASE_TABLE["linux-x64"].sha256).toBe(
      "3237f80fe20d54aad4deefa8a143f0d60543bb5d2d6ad891eb42432f155725a6",
    );
    expect(Object.keys(RELEASE_TABLE).sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"]);
  });
});

describe("ensureTelemetryOptOut idempotence", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "sentrux-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("creates the empty file, succeeds twice, and never deletes anything", async () => {
    const sentinel = join(home, ".sentrux", "sentinel.txt");
    await import("node:fs/promises").then((fs) => fs.mkdir(join(home, ".sentrux"), { recursive: true }));
    await writeFile(sentinel, "keep me");

    const first = await ensureTelemetryOptOut(home);
    expect(first.alreadyExisted).toBe(false);
    expect(await readFile(first.path, "utf8")).toBe("");
    expect(first.path).toBe(join(home, ".sentrux", "telemetry_opt_out"));

    const second = await ensureTelemetryOptOut(home);
    expect(second.alreadyExisted).toBe(true);
    expect(second.path).toBe(first.path);
    expect(await readFile(second.path, "utf8")).toBe("");

    // Never deletes: the sentinel and the opt-out file both survive.
    expect(await readFile(sentinel, "utf8")).toBe("keep me");
  });
});

describe("runTelemetryOffCommand / runRestartCommand / runInstallCommand confirm flows", () => {
  it("telemetry-off requires confirmation and delegates file creation", async () => {
    const { runTelemetryOffCommand } = await import("../../extensions/sentrux/commands.ts");
    const notifications: string[] = [];
    const ensureFn = vi.fn(async () => ({ path: "/fake/.sentrux/telemetry_opt_out", alreadyExisted: false }));
    const ctx: any = {
      hasUI: true,
      signal: undefined,
      ui: {
        confirm: vi.fn(async () => true),
        notify: (msg: string) => void notifications.push(msg),
      },
    };
    await runTelemetryOffCommand({} as any, ctx, { ensureFn });
    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(String(ctx.ui.confirm.mock.calls[0][1])).toMatch(/telemetry_opt_out/);
    expect(ensureFn).toHaveBeenCalledOnce();
    expect(notifications.join("\n")).toMatch(/telemetry turned off/);
  });

  it("telemetry-off cancellation creates nothing", async () => {
    const { runTelemetryOffCommand } = await import("../../extensions/sentrux/commands.ts");
    const ensureFn = vi.fn(async () => ({ path: "/fake/x", alreadyExisted: false }));
    const ctx: any = {
      hasUI: true,
      signal: undefined,
      ui: { confirm: async () => false, notify: () => {} },
    };
    await runTelemetryOffCommand({} as any, ctx, { ensureFn });
    expect(ensureFn).not.toHaveBeenCalled();
  });

  it("restart without sessions closes servers without asking; with sessions it confirms", async () => {
    const { runRestartCommand } = await import("../../extensions/sentrux/commands.ts");
    const closed: string[] = [];
    const notified: string[] = [];

    const noSessionRegistry: any = { listHandles: () => [], closeAll: async () => void closed.push("all") };
    await runRestartCommand(
      { getConfig: () => undefined, registry: noSessionRegistry } as any,
      { hasUI: false, ui: { confirm: async () => true, notify: (m: string) => void notified.push(m) } } as any,
      { resolveFn: (async () => ({ path: "/bin/sentrux", source: "managed", version: { major: 0, minor: 5, patch: 7 } })) as any },
    );
    expect(closed).toEqual(["all"]);

    const confirm = vi.fn(async () => true);
    const sessionRegistry: any = {
      listHandles: () => [{ root: "/r", hasSession: true }],
      closeAll: async () => void closed.push("all2"),
    };
    await runRestartCommand(
      { getConfig: () => undefined, registry: sessionRegistry } as any,
      { hasUI: true, ui: { confirm, notify: (m: string) => void notified.push(m) } } as any,
      { resolveFn: (async () => ({ path: "/bin/sentrux", source: "managed", version: { major: 0, minor: 5, patch: 7 } })) as any },
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(closed).toContain("all2");
  });

  it("install requires a dialog-capable UI", async () => {
    const { runInstallCommand } = await import("../../extensions/sentrux/commands.ts");
    await expect(
      runInstallCommand({} as any, { hasUI: false, ui: { confirm: async () => true, notify: () => {} } } as any),
    ).rejects.toThrow(/dialog-capable UI/);
  });
});
