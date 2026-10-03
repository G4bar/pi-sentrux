import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SentruxConfig } from "../../extensions/sentrux/config.ts";
import { pathExists } from "../../extensions/sentrux/runtime/binary.ts";
import { makeCtx, makeFakePi } from "../helpers.ts";
import { McpClient } from "../../extensions/sentrux/mcp/mcp-client.ts";
import { McpServerRegistry } from "../../extensions/sentrux/mcp/servers.ts";
import {
  registerCheckRulesTool,
  registerGateTool,
  registerInsightsTool,
  registerScanTool,
  registerSessionTool,
  type SentruxMcpToolDeps,
  type SentruxToolDeps,
} from "../../extensions/sentrux/tools.ts";

const SENTRUX_BIN = process.env.SENTRUX_BIN;
const MAKE_FIXTURE_REPO = join(import.meta.dirname, "..", "fixtures", "v0.5.7", "make-fixture-repo.sh");
const P0L_RULES_TOML = ["[[layers]]", 'name = "core"', 'paths = ["src/core/*"]', "order = 0", "", "[[layers]]", 'name = "app"', 'paths = ["src/app/*"]', "order = 1", ""].join(
  "\n",
);

describe.skipIf(!SENTRUX_BIN)("real-binary integration (SENTRUX_BIN)", () => {
  const roots: string[] = [];
  const registries: McpServerRegistry[] = [];

  afterAll(async () => {
    await Promise.all(registries.splice(0).map((r) => r.closeAll()));
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function makeFixtureRoot(): Promise<string> {
    const target = join(tmpdir(), `sentrux-it-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    execFileSync("bash", [MAKE_FIXTURE_REPO, target], { stdio: "pipe" });
    roots.push(target);
    return target;
  }

  function makeDeps(): SentruxToolDeps {
    const config: SentruxConfig = { ...DEFAULT_CONFIG, binaryPath: SENTRUX_BIN, cliTimeoutMs: 120_000, untrackedWarning: true };
    return {
      getConfig: () => config,
      agentDir: join(tmpdir(), "sentrux-it-agent-dir"),
    };
  }

  function makeMcpDeps(): SentruxMcpToolDeps {
    const config: SentruxConfig = { ...DEFAULT_CONFIG, binaryPath: SENTRUX_BIN, mcpStartTimeoutMs: 120_000, mcpCallTimeoutMs: 60_000, untrackedWarning: false };
    const registry = new McpServerRegistry({
      maxServers: () => 3,
      createClient: (r) =>
        new McpClient({
          cwd: r,
          clientVersion: "0.0.0-it",
          startTimeoutMs: 120_000,
          callTimeoutMs: 60_000,
          resolveCommand: () => ({ command: SENTRUX_BIN! }),
        }),
    });
    registries.push(registry);
    return { getConfig: () => config, agentDir: join(tmpdir(), "sentrux-it-agent-dir"), registry };
  }

  it(
    "sentrux_check_rules: layer_direction flags only the higher-order (app) importing the lower-order (core), per P0-L",
    async () => {
      const root = await makeFixtureRoot();
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(root, ".sentrux"), { recursive: true });
      await writeFile(join(root, ".sentrux", "rules.toml"), P0L_RULES_TOML);

      const { pi, registered } = makeFakePi();
      registerCheckRulesTool(pi, makeDeps());

      const result = await registered.sentrux_check_rules.execute("call-check", {}, undefined, undefined, makeCtx(root));

      expect(result.details.status).toBe("fail");
      expect(result.details.rulesChecked).toBe(1);
      expect(typeof result.details.quality).toBe("number");
      expect(result.details.violations).toHaveLength(1);

      const [violation] = result.details.violations;
      expect(violation.rule).toBe("layer_direction");
      expect(violation.message).toContain("app must not depend on core");
      expect(violation.files).toEqual(["src/app/uses_core.ts", "src/core/base.ts"]);

      expect(result.content[0].text).toContain("sentrux check: FAIL — 1 violation(s) (1 rules checked)");
      expect(result.content[0].text).toContain("layer_direction");

      // Untracked-file warning: the genuinely untracked file is flagged with the git-add-N wording;
      // the intent-to-add file (git add -N'd by the fixture script itself) is NOT, since it is already
      // git-tracked for listing purposes (P0-U).
      expect(result.content[0].text).toContain("untracked.ts");
      expect(result.content[0].text).toContain("git add -N");
      expect(result.content[0].text).not.toContain("intent_to_add.ts");
    },
    120_000,
  );

  it(
    "sentrux_check_rules: no_rules when .sentrux/rules.toml is absent",
    async () => {
      const root = await makeFixtureRoot();
      const { pi, registered } = makeFakePi();
      registerCheckRulesTool(pi, makeDeps());

      const result = await registered.sentrux_check_rules.execute("call-norules", {}, undefined, undefined, makeCtx(root));

      expect(result.details.status).toBe("no_rules");
      expect(result.content[0].text).toContain("no .sentrux/rules.toml found");
    },
    120_000,
  );

  it(
    "sentrux_gate: no_baseline -> save (writes baseline.json) -> compare ok",
    async () => {
      const root = await makeFixtureRoot();
      const { pi, registered } = makeFakePi();
      registerGateTool(pi, makeDeps());

      const baselinePath = join(root, ".sentrux", "baseline.json");
      expect(await pathExists(baselinePath)).toBe(false);

      const noBaseline = await registered.sentrux_gate.execute("call-nobaseline", {}, undefined, undefined, makeCtx(root));
      expect(noBaseline.details.status).toBe("no_baseline");
      expect(noBaseline.content[0].text).toContain("call sentrux_gate save=true first");
      expect(await pathExists(baselinePath)).toBe(false);

      const saved = await registered.sentrux_gate.execute("call-save", { save: true }, undefined, undefined, makeCtx(root));
      expect(saved.details.status).toBe("saved");
      expect(await pathExists(baselinePath)).toBe(true);
      const onDisk = JSON.parse(await readFile(baselinePath, "utf8"));
      expect(onDisk).toHaveProperty("quality_signal");
      expect(onDisk).toHaveProperty("cycle_count");
      expect(saved.details.baseline).toEqual(onDisk);

      const compared = await registered.sentrux_gate.execute("call-compare", {}, undefined, undefined, makeCtx(root));
      expect(compared.details.status).toBe("ok");
      expect(compared.content[0].text).toContain("OK vs .sentrux/baseline.json");
    },
    120_000,
  );

  it(
    "MCP: real `sentrux mcp` handshake, scan and health, then registry.closeAll() leaves no process behind",
    async () => {
      const root = await makeFixtureRoot();
      const registry = new McpServerRegistry({
        maxServers: () => 3,
        createClient: (r) =>
          new McpClient({
            cwd: r,
            clientVersion: "0.0.0-it",
            startTimeoutMs: 120_000,
            callTimeoutMs: 60_000,
            resolveCommand: () => ({ command: SENTRUX_BIN! }),
          }),
      });

      const client = await registry.getClient(root);
      expect(client.isAlive).toBe(true);
      const pid = (client as McpClient).pid;
      expect(pid).toBeGreaterThan(0);

      const scanResult = await client.callTool<{ scanned: string; quality_signal: number; files: number; lines: number }>("scan", {
        path: root,
      });
      expect(scanResult.scanned).toBe(root);
      expect(typeof scanResult.quality_signal).toBe("number");
      expect(typeof scanResult.files).toBe("number");
      expect(typeof scanResult.lines).toBe("number");

      const healthResult = await client.callTool<{ quality_signal: number; total_import_edges: number; cross_module_edges: number }>(
        "health",
        {},
      );
      expect(typeof healthResult.quality_signal).toBe("number");
      expect(typeof healthResult.total_import_edges).toBe("number");
      expect(typeof healthResult.cross_module_edges).toBe("number");

      await registry.closeAll();
      expect(client.isAlive).toBe(false);

      expect(() => process.kill(pid!, 0)).toThrow();
    },
    120_000,
  );

  it(
    "sentrux_scan: real quality/bottleneck/root-cause text, at most 8KB",
    async () => {
      const root = await makeFixtureRoot();
      const { pi, registered } = makeFakePi();
      registerScanTool(pi, makeMcpDeps());

      const result = await registered.sentrux_scan.execute("call-scan", {}, undefined, undefined, makeCtx(root));

      expect(typeof result.details.scan.quality_signal).toBe("number");
      expect(typeof result.details.health.bottleneck).toBe("string");
      expect(result.details.health.root_causes).toHaveProperty("acyclicity");
      expect(result.content[0].text).toContain("Sentrux quality");
      expect(result.content[0].text).toContain("bottleneck:");
      expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThanOrEqual(8192 + 256);
    },
    120_000,
  );

  it(
    "sentrux_session: start -> add a new import cycle between two tracked files (committed) -> end reports degraded",
    async () => {
      const root = await makeFixtureRoot();
      const deps = makeMcpDeps();
      const { pi, registered } = makeFakePi();
      registerSessionTool(pi, deps);

      const started = await registered.sentrux_session.execute("call-start", { action: "start" }, undefined, undefined, makeCtx(root));
      expect(started.details.status).toBe("started");
      expect(typeof started.details.qualityAtStart).toBe("number");

      // Add a brand-new 2-file import cycle (distinct from the fixture's existing cycle_a/cycle_b
      // pair) and commit it, so sentrux sees it as git-tracked content.
      await writeFile(
        join(root, "src", "core", "new_cycle_a.ts"),
        ['import { newCycleB } from "./new_cycle_b";', "", "export function newCycleA(): string {", '  return "new-cycle-a";', "}", "", "export const refB = newCycleB;", ""].join("\n"),
      );
      await writeFile(
        join(root, "src", "core", "new_cycle_b.ts"),
        ['import { newCycleA } from "./new_cycle_a";', "", "export function newCycleB(): string {", '  return "new-cycle-b";', "}", "", "export const refA = newCycleA;", ""].join("\n"),
      );
      execFileSync("git", ["add", "src/core/new_cycle_a.ts", "src/core/new_cycle_b.ts"], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "add a second import cycle"], { cwd: root });

      const ended = await registered.sentrux_session.execute("call-end", { action: "end" }, undefined, undefined, makeCtx(root));

      expect(ended.details.status).toBe("degraded");
      expect(ended.details.sessionEnd?.pass).toBe(false);
      expect(ended.content[0].text).toContain("session: DEGRADED");

      // repeatable — a second end still compares against the original start
      const endedAgain = await registered.sentrux_session.execute("call-end-2", { action: "end" }, undefined, undefined, makeCtx(root));
      expect(endedAgain.details.status).toBe("degraded");
    },
    120_000,
  );

  it(
    "sentrux_insights: dsm, test_gaps and git_stats all return real free-tier shapes",
    async () => {
      const root = await makeFixtureRoot();
      const deps = makeMcpDeps();
      const { pi, registered } = makeFakePi();
      registerInsightsTool(pi, deps);

      const dsm = await registered.sentrux_insights.execute("call-dsm", { kind: "dsm" }, undefined, undefined, makeCtx(root));
      expect(dsm.details.kind).toBe("dsm");
      expect(typeof (dsm.details.result as { size: number }).size).toBe("number");
      expect(dsm.content[0].text).toContain("size:");

      const testGaps = await registered.sentrux_insights.execute("call-tg", { kind: "test_gaps" }, undefined, undefined, makeCtx(root));
      expect(testGaps.details.kind).toBe("test_gaps");
      expect(typeof (testGaps.details.result as { source_files: number }).source_files).toBe("number");
      expect(testGaps.content[0].text).toContain("source_files:");

      const gitStats = await registered.sentrux_insights.execute(
        "call-gs",
        { kind: "git_stats", days: 30 },
        undefined,
        undefined,
        makeCtx(root),
      );
      expect(gitStats.details.kind).toBe("git_stats");
      expect((gitStats.details.result as { lookback_days: number }).lookback_days).toBe(30);
      expect(gitStats.content[0].text).toContain("lookback_days: 30");
    },
    120_000,
  );
});
