import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient, McpToolError, type McpClientOptions } from "../../extensions/sentrux/mcp/mcp-client.ts";

const FAKE_SENTRUX = join(import.meta.dirname, "..", "fixtures", "fake-sentrux.mjs");

function makeClient(overrides: Partial<McpClientOptions> & { env?: NodeJS.ProcessEnv } = {}): McpClient {
  return new McpClient({
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [FAKE_SENTRUX] }),
    cwd: process.cwd(),
    clientVersion: "0.0.0-test",
    startTimeoutMs: 5000,
    callTimeoutMs: 5000,
    closeSigtermDelayMs: 50,
    closeSigkillDelayMs: 50,
    env: { ...process.env, ...overrides.env },
    ...overrides,
  });
}

describe("McpClient", () => {
  const clients: McpClient[] = [];

  function track(client: McpClient): McpClient {
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it("completes the handshake and reports serverInfo/generation", async () => {
    const client = track(makeClient());
    await client.start();
    expect(client.serverInfo?.name).toBe("sentrux");
    expect(client.serverInfo?.version).toBe("0.5.7");
    expect(client.isAlive).toBe(true);
    expect(client.generation).toBe(0);
  });

  it("throws when a required MCP tool is missing from tools/list", async () => {
    const client = track(makeClient({ env: { FAKE_SENTRUX_MCP_MISSING_TOOL: "scan" } }));
    await expect(client.start()).rejects.toThrow(/lacks MCP tool scan/);
  });

  it("callTool throws McpToolError when the server sets isError", async () => {
    const client = track(makeClient({ env: { FAKE_SENTRUX_MCP_ERROR_TOOL: "scan", FAKE_SENTRUX_MCP_ERROR_TEXT: "scan blew up" } }));
    let caught: unknown;
    try {
      await client.callTool("scan", { path: "." });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as Error).message).toContain("scan blew up");
  });

  it("callTool parses the JSON string in content[0].text", async () => {
    const client = track(makeClient());
    const result = await client.callTool<{ scanned: string; quality_signal: number }>("scan", { path: "." });
    expect(result.scanned).toBe(".");
    expect(result.quality_signal).toBe(4674);
  });

  it("a JSON-RPC error response rejects the call", async () => {
    const client = track(
      makeClient({ env: { FAKE_SENTRUX_MCP_RPC_ERROR_METHOD: "tools/call", FAKE_SENTRUX_MCP_RPC_ERROR_TEXT: "server said no" } }),
    );
    await expect(client.callTool("scan", { path: "." })).rejects.toThrow(/server said no/);
  });

  it("ignores a garbage non-JSON stdout line and keeps working", async () => {
    const client = track(makeClient({ env: { FAKE_SENTRUX_MCP_GARBAGE_AFTER: "tools/list" } }));
    await client.start();
    expect(client.isAlive).toBe(true);
    const result = await client.callTool<{ scanned: string }>("scan", { path: "." });
    expect(result.scanned).toBe(".");
  });

  it("a timeout kills the process and the next call respawns it with generation+1", async () => {
    const client = track(makeClient({ callTimeoutMs: 200, env: { FAKE_SENTRUX_MCP_HANG_TOOL: "scan" } }));
    await client.start();
    expect(client.generation).toBe(0);

    await expect(client.callTool("scan", { path: "." })).rejects.toThrow(/timed out/);
    expect(client.isAlive).toBe(false);

    const health = await client.callTool<{ quality_signal: number }>("health", {});
    expect(health.quality_signal).toBe(4674);
    expect(client.generation).toBe(1);
    expect(client.isAlive).toBe(true);
  });

  it("a crash mid-call rejects the pending request with the exit reason", async () => {
    const client = track(makeClient({ env: { FAKE_SENTRUX_MCP_CRASH_TOOL: "scan" } }));
    await client.start();
    await expect(client.callTool("scan", { path: "." })).rejects.toThrow(/exited code 1/);
    expect(client.isAlive).toBe(false);
  });

  it("a stdin EPIPE on a dying child routes to child-down, kills the process, and respawns on the next call", async () => {
    const client = track(makeClient());
    await client.start();
    expect(client.isAlive).toBe(true);
    const oldPid = client.pid;
    expect(oldPid).toBeGreaterThan(0);

    // An async stdin failure arrives as an 'error' event the write try/catch cannot
    // catch; without the stdin error listener this would throw uncaught. Emit one directly.
    const child = (client as unknown as { child: { stdin: NodeJS.EventEmitter } }).child;
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(client.isAlive).toBe(false);

    // The broken-stdin process is killed, not orphaned: it must actually exit.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        process.kill(oldPid!, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(() => process.kill(oldPid!, 0)).toThrow();

    // The client recovers: the next call respawns the server with generation+1.
    const health = await client.callTool<{ quality_signal: number }>("health", {});
    expect(health.quality_signal).toBe(4674);
    expect(client.generation).toBe(1);
    expect(client.isAlive).toBe(true);
    expect(client.pid).not.toBe(oldPid);
  });

  it("close() during start leaves no spawned process behind", async () => {
    let release!: (cli: { command: string; prefixArgs?: string[] }) => void;
    const gate = new Promise<{ command: string; prefixArgs?: string[] }>((resolve) => {
      release = resolve;
    });
    const client = track(makeClient({ resolveCommand: () => gate }));
    const started = client.start();
    await new Promise((resolve) => setImmediate(resolve));
    await client.close();
    release({ command: process.execPath, prefixArgs: [FAKE_SENTRUX] });
    await expect(started).rejects.toThrow(/closed during start/);
    expect((client as unknown as { child: unknown }).child).toBeUndefined();
    expect(client.pid).toBeUndefined();
    expect(client.isAlive).toBe(false);
  });

  it("an already-aborted signal rejects immediately instead of hanging", async () => {
    const client = track(makeClient());
    await client.start();
    const controller = new AbortController();
    controller.abort();
    await expect(client.callTool("scan", { path: "." }, { signal: controller.signal, timeoutMs: 5000 })).rejects.toThrow(
      /aborted/,
    );
    expect(client.isAlive).toBe(false);
  });

  it("close() ends the process via stdin EOF when the server cooperates", async () => {
    const client = track(makeClient());
    await client.start();
    await client.close();
    expect(client.isAlive).toBe(false);
  });

  it("close() falls through to SIGTERM when the server ignores stdin EOF", async () => {
    const client = track(makeClient({ env: { FAKE_SENTRUX_MCP_IGNORE_EOF: "1" } }));
    await client.start();
    const start = Date.now();
    await client.close();
    const elapsed = Date.now() - start;
    expect(client.isAlive).toBe(false);
    // Should not have waited for the (much longer) default timeouts; the test overrides
    // closeSigtermDelayMs/closeSigkillDelayMs to 50ms each.
    expect(elapsed).toBeLessThan(3000);
  });
});
