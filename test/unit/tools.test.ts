import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SentruxConfig } from "../../extensions/sentrux/config.ts";
import { pathExists } from "../../extensions/sentrux/binary.ts";
import { registerCheckRulesTool, registerGateTool, type SentruxToolDeps } from "../../extensions/sentrux/tools.ts";
import { makeConfig, makeCtx, makeFakePi } from "../helpers.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "v0.5.7");
const FAKE_CLI = join(import.meta.dirname, "..", "fixtures", "fake-sentrux.mjs");

const FAKE_ENV_KEYS = [
  "FAKE_SENTRUX_SCENARIO_DIR",
  "FAKE_SENTRUX_STDOUT",
  "FAKE_SENTRUX_STDERR",
  "FAKE_SENTRUX_EXIT_CODE",
  "FAKE_SENTRUX_BASELINE_JSON",
] as const;

async function withFakeSentrux(env: Partial<Record<(typeof FAKE_ENV_KEYS)[number], string>>, fn: () => Promise<any>): Promise<any> {
  const prev: Record<string, string | undefined> = {};
  for (const key of FAKE_ENV_KEYS) prev[key] = process.env[key];
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const key of FAKE_ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function checkScenario(dir: string) {
  return { FAKE_SENTRUX_SCENARIO_DIR: join(FIXTURES, "check", dir) };
}

function gateScenario(dir: string) {
  return { FAKE_SENTRUX_SCENARIO_DIR: join(FIXTURES, "gate", dir) };
}

function makeDeps(_binaryPath: string, config: SentruxConfig, cliOverride?: { command: string; prefixArgs?: string[] }): SentruxToolDeps {
  return {
    getConfig: () => config,
    agentDir: join(tmpdir(), "sentrux-tools-test-agent-dir"),
    resolveBinaryRun: async () => ({ code: 0, stdout: "sentrux 0.5.7\n", stderr: "", timedOut: false, aborted: false }),
    cli: cliOverride ?? { command: process.execPath, prefixArgs: [FAKE_CLI] },
  };
}

const tmpDirs: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sentrux-tools-"));
  tmpDirs.push(dir);
  return dir;
}

async function makeBinaryFile(root: string): Promise<string> {
  const path = join(root, "fake-binary");
  await writeFile(path, "not actually run\n");
  return path;
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeConfig(overrides: Partial<SentruxConfig> = {}): SentruxConfig {
  return makeConfig({ cliTimeoutMs: 5000, untrackedWarning: false, ...overrides });
}

describe("sentrux_check_rules", () => {
  it("returns no_rules (does not throw) when .sentrux/rules.toml is missing", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    const result = await withFakeSentrux({}, () =>
      registered.sentrux_check_rules.execute("call-1", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("no_rules");
    expect(result.content[0].text).toContain("no .sentrux/rules.toml found");
  });

  it("returns pass (does not throw) for a passing rules.toml", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nmin_quality = 0.0\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    const result = await withFakeSentrux(checkScenario("many-rules-pass"), () =>
      registered.sentrux_check_rules.execute("call-2", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details).toMatchObject({ status: "pass", rulesChecked: 4, quality: 4674 });
    expect(result.content[0].text).toContain("PASS (4 rules checked) · quality 4674");
  });

  it("returns fail (does not throw) for a failing rules.toml, with violations in details", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nmax_cycles = 0\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    const result = await withFakeSentrux(checkScenario("many-rules-fail"), () =>
      registered.sentrux_check_rules.execute("call-3", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("fail");
    expect(result.details.violations).toHaveLength(4);
    expect(result.content[0].text).toContain("FAIL — 4 violation(s) (5 rules checked) · quality 4674");
  });

  it("throws Invalid .sentrux/rules.toml when stderr reports a TOML parse failure", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints\nmin_quality = 0.0\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    await withFakeSentrux(checkScenario("invalid-toml"), async () => {
      await expect(registered.sentrux_check_rules.execute("call-4", {}, undefined, undefined, makeCtx(root))).rejects.toThrow(
        /Invalid \.sentrux\/rules\.toml:.*Failed to parse/,
      );
    });
  });

  it("throws with the stderr tail for an unrecognized CLI failure", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    await withFakeSentrux(
      { FAKE_SENTRUX_STDOUT: "", FAKE_SENTRUX_STDERR: "internal error: boom", FAKE_SENTRUX_EXIT_CODE: "2" },
      async () => {
        await expect(registered.sentrux_check_rules.execute("call-5", {}, undefined, undefined, makeCtx(root))).rejects.toThrow(
          /sentrux check failed:.*internal error: boom/,
        );
      },
    );
  });

  it("truncates files per violation in content to maxFilesPerViolation, keeping the full list in details", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nno_god_files = true\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    const fileLines = Array.from({ length: 25 }, (_, i) => `    src/file${i}.ts`);
    const stdout = [
      "sentrux check — 1 rules checked",
      "",
      "Quality: 5000",
      "",
      "✗ [Error] no_god_files: 1 god file(s) found (fan-out > 15)",
      ...fileLines,
      "",
      "✗ 1 violation(s) found",
    ].join("\n");

    const result = await withFakeSentrux({ FAKE_SENTRUX_STDOUT: stdout, FAKE_SENTRUX_EXIT_CODE: "1" }, () =>
      registered.sentrux_check_rules.execute("call-6", { maxFilesPerViolation: 5 }, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.violations[0].files).toHaveLength(25);
    expect(result.content[0].text).toContain("✗ [Error] no_god_files (1 violation): 1 god file(s) found (fan-out > 15)");
    expect(result.content[0].text).toContain("… 20 more");
    expect(result.content[0].text.match(/src\/file\d+\.ts/g)).toHaveLength(5);
  });

  it("includes the untracked-file warning (git add -N wording) when untrackedWarning is enabled", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    await writeFile(join(root, "untracked.ts"), "export const b = 2;\n");

    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath, untrackedWarning: true })));

    const result = await withFakeSentrux({}, () =>
      registered.sentrux_check_rules.execute("call-7", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.content[0].text).toContain("untracked");
    expect(result.content[0].text).toContain("untracked.ts");
    expect(result.content[0].text).toContain("git add -N");
    expect(result.content[0].text).toContain("ask the user");
  });

  it("with 60 violations, groups per rule with compact edges and keeps the untracked warning first", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nmax_cycles = 0\n");
    await writeFile(join(root, "tracked.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "tracked.ts", ".sentrux/rules.toml"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    await writeFile(join(root, "untracked.ts"), "export const b = 2;\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(
      pi,
      makeDeps(binaryPath, fakeConfig({ binaryPath, untrackedWarning: true, maxOutputBytes: 4096, maxOutputLines: 200 })),
    );

    const edgeBlocks = Array.from(
      { length: 60 },
      (_, i) =>
        `✗ [Error] layer_direction: Layer violation: src/app/f${i}.ts (app) imports src/core/g${i}.ts (core). app must not depend on core.\n` +
        `    src/app/f${i}.ts\n    src/core/g${i}.ts`,
    );
    const stdout = ["sentrux check — 4 rules checked", "", "Quality: 5955", "", ...edgeBlocks, "", "✗ 60 violation(s) found"].join("\n");

    const result = await withFakeSentrux({ FAKE_SENTRUX_STDOUT: stdout, FAKE_SENTRUX_EXIT_CODE: "1" }, () =>
      registered.sentrux_check_rules.execute("call-60", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("fail");
    expect(result.details.violations).toHaveLength(60);
    const text: string = result.content[0].text;
    // The warning leads the text, so truncation (tail is dropped) can never remove it.
    expect(text.startsWith("⚠")).toBe(true);
    expect(text).toContain("untracked.ts");
    expect(text).toContain("git add -N");
    expect(text).not.toContain(".sentrux/rules.toml");
    expect(text).toContain("FAIL — 60 violation(s) (4 rules checked) · quality 5955");
    expect(text).toContain("✗ [Error] layer_direction (60 violations)");
    expect(text).toContain("src/app/f0.ts → src/core/g0.ts");
    expect(text).toContain("… 40 more");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("throws Not a directory for a path that is not a directory", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const filePath = join(root, "a-file.txt");
    await writeFile(filePath, "x");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    await expect(
      registered.sentrux_check_rules.execute("call-8", { path: filePath }, undefined, undefined, makeCtx(root)),
    ).rejects.toThrow(/Not a directory/);
  });

  it("trusts a parseable pass summary even when the exit code is 1", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nmin_quality = 0.0\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));
    const stdout = await readFile(join(FIXTURES, "check", "many-rules-pass", "stdout.txt"), "utf8");

    const result = await withFakeSentrux({ FAKE_SENTRUX_STDOUT: stdout, FAKE_SENTRUX_EXIT_CODE: "1" }, () =>
      registered.sentrux_check_rules.execute("call-exit-1", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("pass");
  });

  it("trusts a parseable fail summary even when the exit code is 0", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nmax_cycles = 0\n");
    const { pi, registered } = makeFakePi();
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));
    const stdout = await readFile(join(FIXTURES, "check", "many-rules-fail", "stdout.txt"), "utf8");

    const result = await withFakeSentrux({ FAKE_SENTRUX_STDOUT: stdout, FAKE_SENTRUX_EXIT_CODE: "0" }, () =>
      registered.sentrux_check_rules.execute("call-exit-0", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("fail");
    expect(result.details.violations.length).toBeGreaterThan(0);
  });

  it("reports a CLI timeout as a timeout, not a generic failure", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nmin_quality = 0.0\n");
    const { pi, registered } = makeFakePi();
    const hangingCli = { command: process.execPath, prefixArgs: ["-e", "setTimeout(() => {}, 30000)"] };
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath, cliTimeoutMs: 200 }), hangingCli));

    await expect(
      registered.sentrux_check_rules.execute("call-timeout", {}, undefined, undefined, makeCtx(root)),
    ).rejects.toThrow(/sentrux check timed out after 200ms/);
  });

  it("reports a CLI abort as aborted, not a generic failure", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), "[constraints]\nmin_quality = 0.0\n");
    const { pi, registered } = makeFakePi();
    const hangingCli = { command: process.execPath, prefixArgs: ["-e", "setTimeout(() => {}, 30000)"] };
    registerCheckRulesTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath }), hangingCli));
    const controller = new AbortController();
    controller.abort();

    await expect(
      registered.sentrux_check_rules.execute("call-abort", {}, controller.signal, undefined, makeCtx(root)),
    ).rejects.toThrow(/sentrux check aborted/);
  });
});

describe("sentrux_gate", () => {
  it("throws when save:true is blocked by allowBaselineWrite:false, without invoking the CLI", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath, allowBaselineWrite: false })));

    await withFakeSentrux({ FAKE_SENTRUX_EXIT_CODE: "1", FAKE_SENTRUX_STDERR: "should never run" }, async () => {
      await expect(registered.sentrux_gate.execute("call-1", { save: true }, undefined, undefined, makeCtx(root))).rejects.toThrow(
        /allowBaselineWrite/,
      );
    });

    expect(await pathExists(join(root, ".sentrux", "baseline.json"))).toBe(false);
  });

  it("save:true writes .sentrux/baseline.json and returns status saved with details.baseline", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath, allowBaselineWrite: true })));

    const result = await withFakeSentrux(gateScenario("save"), () =>
      registered.sentrux_gate.execute("call-2", { save: true }, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("saved");
    expect(result.details.quality).toEqual({ before: 4674, after: 4674 });

    const baselinePath = join(root, ".sentrux", "baseline.json");
    expect(await pathExists(baselinePath)).toBe(true);
    const onDisk = JSON.parse(await readFile(baselinePath, "utf8"));
    expect(onDisk.quality_signal).toBeCloseTo(0.4674147779627381, 5);
    expect(result.details.baseline).toEqual(onDisk);
  });

  it("save:false (default) never writes .sentrux/baseline.json", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath, allowBaselineWrite: true })));

    await withFakeSentrux(gateScenario("ok"), () =>
      registered.sentrux_gate.execute("call-3", {}, undefined, undefined, makeCtx(root)),
    );

    expect(await pathExists(join(root, ".sentrux", "baseline.json"))).toBe(false);
  });

  it("compare returns ok (does not throw) with no degradation", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    const result = await withFakeSentrux(gateScenario("ok"), () =>
      registered.sentrux_gate.execute("call-4", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("ok");
    expect(result.content[0].text).toContain("OK vs .sentrux/baseline.json");
  });

  it("compare returns degraded (does not throw) with reasons, exit 1", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    const result = await withFakeSentrux(gateScenario("degraded"), () =>
      registered.sentrux_gate.execute("call-5", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("degraded");
    expect(result.details.reasons).toEqual(["Quality signal dropped: 0.47 → 0.43 (-0.03)", "Cycles increased: 1 → 2"]);
    expect(result.content[0].text).toContain("DEGRADED vs .sentrux/baseline.json");
    expect(result.content[0].text).toContain("reasons (Sentrux 0–1 scale): Quality signal dropped");
  });

  it("compare with no baseline file returns no_baseline (does not throw)", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    const result = await withFakeSentrux(gateScenario("missing-baseline"), () =>
      registered.sentrux_gate.execute("call-6", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("no_baseline");
    expect(result.content[0].text).toContain("call sentrux_gate save=true first");
  });

  it("trusts a parseable degraded summary even when the exit code is 0", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));
    const stdout = await readFile(join(FIXTURES, "gate", "degraded", "stdout.txt"), "utf8");

    const result = await withFakeSentrux({ FAKE_SENTRUX_STDOUT: stdout, FAKE_SENTRUX_EXIT_CODE: "0" }, () =>
      registered.sentrux_gate.execute("call-exit-0", {}, undefined, undefined, makeCtx(root)),
    );

    expect(result.details.status).toBe("degraded");
  });

  it("throws with the stderr tail for an unrecognized compare failure", async () => {
    const root = await makeRoot();
    const binaryPath = await makeBinaryFile(root);
    const { pi, registered } = makeFakePi();
    registerGateTool(pi, makeDeps(binaryPath, fakeConfig({ binaryPath })));

    await withFakeSentrux(
      { FAKE_SENTRUX_STDOUT: "", FAKE_SENTRUX_STDERR: "internal error: kaboom", FAKE_SENTRUX_EXIT_CODE: "2" },
      async () => {
        await expect(registered.sentrux_gate.execute("call-7", {}, undefined, undefined, makeCtx(root))).rejects.toThrow(
          /sentrux gate failed:.*internal error: kaboom/,
        );
      },
    );
  });
});
