import { describe, expect, it } from "vitest";
import type { BinaryStatus } from "../../extensions/sentrux/runtime/binary.ts";
import { buildStatusReport, type StatusDeps } from "../../extensions/sentrux/commands.ts";
import type { McpServerRegistry } from "../../extensions/sentrux/mcp/servers.ts";

const FAKE_BINARY_STATUS: BinaryStatus = {
  path: "/fake/sentrux",
  source: "path",
  version: { major: 0, minor: 5, patch: 7, pro: false, raw: "0.5.7" },
};

function makeCtx(cwd: string, trusted = false): any {
  return { cwd, isProjectTrusted: () => trusted };
}

function makeRegistry(handles: ReturnType<McpServerRegistry["listHandles"]>): McpServerRegistry {
  return { listHandles: () => handles } as unknown as McpServerRegistry;
}

function makeDeps(registry: McpServerRegistry): StatusDeps {
  return {
    getConfig: () => undefined,
    getWarmup: () => Promise.resolve(FAKE_BINARY_STATUS),
    agentDir: "/fake/agent-dir",
    globalConfigPath: "/fake/agent-dir/config.json",
    registry,
  };
}

describe("buildStatusReport", () => {
  it('reports "Active servers: none" when the registry has no handles', async () => {
    const report = await buildStatusReport(makeDeps(makeRegistry([])), makeCtx("/tmp"));
    expect(report).toContain("Active servers: none");
  });

  it("lists each handle's root, pid, generation, and session state", async () => {
    const registry = makeRegistry([
      { root: "/repo/a", generation: 0, hasSession: true, lostSession: false, lastUsed: Date.now(), pid: 4242, sessionBaseline: undefined, alive: true },
      { root: "/repo/b", generation: 2, hasSession: false, lostSession: true, lastUsed: Date.now(), pid: undefined, sessionBaseline: undefined, alive: false },
      { root: "/repo/c", generation: 0, hasSession: false, lostSession: false, lastUsed: Date.now(), pid: 9000, sessionBaseline: undefined, alive: true },
    ]);
    const report = await buildStatusReport(makeDeps(registry), makeCtx("/tmp"));

    expect(report).toContain("Active servers (3):");
    expect(report).toContain("/repo/a — pid 4242, generation 0, session baseline active");
    expect(report).toContain("/repo/b — not running, generation 2, session lost (server restarted)");
    expect(report).toContain("/repo/c — pid 9000, generation 0, no session");
  });
});
