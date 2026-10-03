import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SentruxConfig } from "../../extensions/sentrux/config.ts";
import { McpClient } from "../../extensions/sentrux/mcp/mcp-client.ts";
import { McpServerRegistry } from "../../extensions/sentrux/mcp/servers.ts";
import { registerInsightsTool, registerScanTool, registerSessionTool, type SentruxMcpToolDeps } from "../../extensions/sentrux/tools.ts";
import { makeConfig, makeCtx, makeFakePi } from "../helpers.ts";

const FAKE_SENTRUX = join(import.meta.dirname, "..", "fixtures", "fake-sentrux.mjs");

const registries: McpServerRegistry[] = [];
const tmpDirs: string[] = [];

function fakeConfig(overrides: Partial<SentruxConfig> = {}): SentruxConfig {
  return makeConfig({ untrackedWarning: false, mcpStartTimeoutMs: 5000, mcpCallTimeoutMs: 5000, ...overrides });
}

function makeRegistry(config: SentruxConfig, env?: NodeJS.ProcessEnv): McpServerRegistry {
  const registry = new McpServerRegistry({
    maxServers: () => config.maxServers,
    createClient: (root) =>
      new McpClient({
        cwd: root,
        clientVersion: "0.0.0-test",
        startTimeoutMs: config.mcpStartTimeoutMs,
        callTimeoutMs: config.mcpCallTimeoutMs,
        env: env ? { ...process.env, ...env } : process.env,
        resolveCommand: () => ({ command: process.execPath, prefixArgs: [FAKE_SENTRUX] }),
      }),
  });
  registries.push(registry);
  return registry;
}

function makeDeps(config: SentruxConfig, registry: McpServerRegistry): SentruxMcpToolDeps {
  return { getConfig: () => config, agentDir: join(tmpdir(), "sentrux-mcp-tools-test-agent-dir"), registry };
}

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sentrux-mcp-tools-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(registries.splice(0).map((r) => r.closeAll(500)));
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** forceKillSync only sends the signal; the client's `dead` flag flips on the async `close`
 * event. Without this wait, the next getClient()->start() can run while isAlive is still true
 * and miss the crash entirely — a timing race that flakes under parallel load. */
async function awaitClientDead(client: { readonly isAlive: boolean }, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (client.isAlive) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the fake MCP server to die");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("sentrux_scan", () => {
  it("calls scan then health, returning quality/bottleneck text with populated details", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerScanTool(pi, makeDeps(config, registry));

    const result = await registered.sentrux_scan.execute("call-1", {}, undefined, undefined, makeCtx(root));

    expect(result.details.root).toBe(root);
    expect(result.details.scan).toMatchObject({ files: 29, lines: 107, import_edges: 22, quality_signal: 4674 });
    expect(result.details.health).toMatchObject({ bottleneck: "none", quality_signal: 4674 });
    expect(result.details.untracked).toEqual({ count: 0, sample: [] });
    expect(result.content[0].text).toContain("Sentrux quality 4674/10000 — bottleneck: none");
    expect(result.content[0].text).toContain("files 29 · lines 107 · import edges 22 (cross-module 0)");
  });

  it("throws (no soft status) when the scan MCP call fails", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config, { FAKE_SENTRUX_MCP_ERROR_TOOL: "scan", FAKE_SENTRUX_MCP_ERROR_TEXT: "scan blew up" });
    const { pi, registered } = makeFakePi();
    registerScanTool(pi, makeDeps(config, registry));

    await expect(registered.sentrux_scan.execute("call-2", {}, undefined, undefined, makeCtx(root))).rejects.toThrow(/scan blew up/);
  });

  it("throws Not a directory for a path that is not a directory", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerScanTool(pi, makeDeps(config, registry));

    await expect(
      registered.sentrux_scan.execute("call-3", { path: join(root, "does-not-exist") }, undefined, undefined, makeCtx(root)),
    ).rejects.toThrow(/Not a directory/);
  });
});

describe("sentrux_session", () => {
  it("start scans, records a baseline, and marks the registry session started (does not throw)", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    const result = await registered.sentrux_session.execute("call-1", { action: "start" }, undefined, undefined, makeCtx(root));

    expect(result.details).toMatchObject({ action: "start", status: "started", qualityAtStart: 4674 });
    expect(result.content[0].text).toContain("session: started — quality 4674 recorded as baseline");
    expect(registry.getHandleInfo(root)?.hasSession).toBe(true);
  });

  it("end without a prior start returns no_session (does not throw) without spawning a server", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    const result = await registered.sentrux_session.execute("call-1", { action: "end" }, undefined, undefined, makeCtx(root));

    expect(result.details.status).toBe("no_session");
    expect(result.content[0].text).toContain("call sentrux_session action=start first");
    expect(registry.getHandleInfo(root)).toBeUndefined();
  });

  it("status without a prior start returns no_session (does not throw)", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    const result = await registered.sentrux_session.execute("call-1", { action: "status" }, undefined, undefined, makeCtx(root));

    expect(result.details.status).toBe("no_session");
  });

  it("start then end reports pass (does not throw) with signal before/after", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    await registered.sentrux_session.execute("call-1", { action: "start" }, undefined, undefined, makeCtx(root));
    const result = await registered.sentrux_session.execute("call-2", { action: "end" }, undefined, undefined, makeCtx(root));

    expect(result.details.status).toBe("pass");
    expect(result.details.sessionEnd).toMatchObject({ pass: true, signal_before: 4674, signal_after: 4674 });
    expect(result.content[0].text).toContain("session: PASS");

    // repeatable — always compares against the original start
    const result2 = await registered.sentrux_session.execute("call-3", { action: "end" }, undefined, undefined, makeCtx(root));
    expect(result2.details.status).toBe("pass");
  });

  it("status after start reports the recorded baseline (does not throw)", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    await registered.sentrux_session.execute("call-1", { action: "start" }, undefined, undefined, makeCtx(root));
    const result = await registered.sentrux_session.execute("call-2", { action: "status" }, undefined, undefined, makeCtx(root));

    expect(result.details).toMatchObject({ status: "started", qualityAtStart: 4674 });
    expect(result.content[0].text).toContain("session: active — baseline quality 4674");
  });

  it("end after the server respawns (simulated crash) returns lost (does not throw), telling the model to start again", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    await registered.sentrux_session.execute("call-1", { action: "start" }, undefined, undefined, makeCtx(root));
    const client = await registry.getClient(root);
    client.forceKillSync();
    await awaitClientDead(client);

    const result = await registered.sentrux_session.execute("call-2", { action: "end" }, undefined, undefined, makeCtx(root));

    expect(result.details.status).toBe("lost");
    expect(result.content[0].text).toContain("session: lost");
    expect(result.content[0].text).toContain("call sentrux_session action=start again");
  });

  it("status is local state only: it still reports the stale baseline right after a crash it hasn't observed yet", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    await registered.sentrux_session.execute("call-1", { action: "start" }, undefined, undefined, makeCtx(root));
    const client = await registry.getClient(root);
    client.forceKillSync();
    await awaitClientDead(client);

    // status never talks to the server, so it cannot discover the crash by itself.
    const result = await registered.sentrux_session.execute("call-2", { action: "status" }, undefined, undefined, makeCtx(root));
    expect(result.details.status).toBe("started");
  });

  it("status reflects lost once another action has observed the respawn via the registry", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    await registered.sentrux_session.execute("call-1", { action: "start" }, undefined, undefined, makeCtx(root));
    const client = await registry.getClient(root);
    client.forceKillSync();
    await awaitClientDead(client);
    await registered.sentrux_session.execute("call-2", { action: "end" }, undefined, undefined, makeCtx(root)); // observes the respawn

    const result = await registered.sentrux_session.execute("call-3", { action: "status" }, undefined, undefined, makeCtx(root));
    expect(result.details.status).toBe("lost");
  });

  it("throws Not a directory for a path that is not a directory", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerSessionTool(pi, makeDeps(config, registry));

    await expect(
      registered.sentrux_session.execute(
        "call-1",
        { action: "start", path: join(root, "does-not-exist") },
        undefined,
        undefined,
        makeCtx(root),
      ),
    ).rejects.toThrow(/Not a directory/);
  });
});

describe("sentrux_insights", () => {
  it("dsm: scans then calls dsm (does not throw), passing format only when given", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerInsightsTool(pi, makeDeps(config, registry));

    const result = await registered.sentrux_insights.execute("call-1", { kind: "dsm" }, undefined, undefined, makeCtx(root));

    expect(result.details.kind).toBe("dsm");
    expect(result.details.result).toMatchObject({ size: 0, density: 0 });
    expect(result.content[0].text).toContain("size: 0");
  });

  it("test_gaps: scans then calls test_gaps (does not throw), passing limit only when given", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerInsightsTool(pi, makeDeps(config, registry));

    const result = await registered.sentrux_insights.execute(
      "call-1",
      { kind: "test_gaps", limit: 5 },
      undefined,
      undefined,
      makeCtx(root),
    );

    expect(result.details.kind).toBe("test_gaps");
    expect(result.content[0].text).toContain("source_files: 0");
    expect(result.content[0].text).toContain("(free tier: counts only)");
  });

  it("git_stats: scans then calls git_stats (does not throw), passing days only when given", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerInsightsTool(pi, makeDeps(config, registry));

    const result = await registered.sentrux_insights.execute(
      "call-1",
      { kind: "git_stats", days: 7 },
      undefined,
      undefined,
      makeCtx(root),
    );

    expect(result.details.kind).toBe("git_stats");
    expect((result.details.result as { lookback_days: number }).lookback_days).toBe(7);
    expect(result.content[0].text).toContain("lookback_days: 7");
  });

  it("throws (no soft status) when the underlying MCP call fails", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config, { FAKE_SENTRUX_MCP_ERROR_TOOL: "dsm", FAKE_SENTRUX_MCP_ERROR_TEXT: "dsm blew up" });
    const { pi, registered } = makeFakePi();
    registerInsightsTool(pi, makeDeps(config, registry));

    await expect(
      registered.sentrux_insights.execute("call-1", { kind: "dsm" }, undefined, undefined, makeCtx(root)),
    ).rejects.toThrow(/dsm blew up/);
  });

  it("throws Not a directory for a path that is not a directory", async () => {
    const root = await makeRoot();
    const config = fakeConfig();
    const registry = makeRegistry(config);
    const { pi, registered } = makeFakePi();
    registerInsightsTool(pi, makeDeps(config, registry));

    await expect(
      registered.sentrux_insights.execute(
        "call-1",
        { kind: "dsm", path: join(root, "does-not-exist") },
        undefined,
        undefined,
        makeCtx(root),
      ),
    ).rejects.toThrow(/Not a directory/);
  });
});
