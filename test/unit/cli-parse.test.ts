import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCheckOutput, parseGateCompareOutput, parseGateSaveOutput } from "../../extensions/sentrux/cli.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "v0.5.7");

function readCheckStdout(scenario: string): string {
  return readFileSync(join(FIXTURES, "check", scenario, "stdout.txt"), "utf8");
}

function readGateStdout(scenario: string): string {
  return readFileSync(join(FIXTURES, "gate", scenario, "stdout.txt"), "utf8");
}

describe("parseCheckOutput — Phase 0 fixtures", () => {
  it("many-rules-pass: pass with rule count and quality", () => {
    const outcome = parseCheckOutput(readCheckStdout("many-rules-pass"));
    expect(outcome).toEqual({ kind: "pass", rulesChecked: 4, quality: 4674 });
  });

  it("many-rules-fail: fail with 4 violations, files attached to the right violation", () => {
    const outcome = parseCheckOutput(readCheckStdout("many-rules-fail"));
    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") throw new Error("unreachable");
    expect(outcome.rulesChecked).toBe(5);
    expect(outcome.quality).toBe(4674);
    expect(outcome.violationCount).toBe(4);
    expect(outcome.violations).toEqual([
      {
        severity: "Error",
        rule: "max_cycles",
        message: "Found 1 circular dependencies, maximum allowed is 0",
        files: ["src/core/cycle_a.ts", "src/core/cycle_b.ts"],
      },
      {
        severity: "Error",
        rule: "max_cc",
        message: "1 function(s) exceed max cyclomatic complexity of 10",
        files: ["src/app/complex.ts:complexDecision (cc=21)"],
      },
      {
        severity: "Error",
        rule: "no_god_files",
        message: "1 god file(s) found (fan-out > 15)",
        files: ["src/app/god.ts (fan-out=16)"],
      },
      {
        severity: "Error",
        rule: "max_upward_violations",
        message: "2 upward dependency violations, maximum allowed is 0",
        files: ["src/core/cycle_a.ts (L0) → src/core/cycle_b.ts (L0)", "src/core/cycle_b.ts (L0) → src/core/cycle_a.ts (L0)"],
      },
    ]);
  });

  it("max-rules: 15 rules, 15 violations including layer_direction and boundary", () => {
    const outcome = parseCheckOutput(readCheckStdout("max-rules"));
    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") throw new Error("unreachable");
    expect(outcome.rulesChecked).toBe(15);
    expect(outcome.violationCount).toBe(15);
    expect(outcome.violations).toHaveLength(15);
    expect(outcome.violations.map((v) => v.rule)).toEqual([
      "min_quality",
      "min_modularity",
      "min_acyclicity",
      "min_depth",
      "min_equality",
      "min_redundancy",
      "max_coupling_score",
      "max_cycles",
      "max_cc",
      "max_file_lines",
      "max_fn_lines",
      "no_god_files",
      "max_upward_violations",
      "layer_direction",
      "boundary",
    ]);
    const layer = outcome.violations.find((v) => v.rule === "layer_direction");
    expect(layer?.message).toBe(
      "Layer violation: src/app/uses_core.ts (app) imports src/core/base.ts (core). app must not depend on core.",
    );
    const maxFileLines = outcome.violations.find((v) => v.rule === "max_file_lines");
    expect(maxFileLines?.files).toEqual([
      "src/app/complex.ts (23 lines)",
      "src/app/god.ts (21 lines)",
      "src/core/cycle_a.ts (7 lines)",
      "src/core/cycle_b.ts (7 lines)",
    ]);
  });

  it("boundaries: single boundary violation, message keeps its embedded colon", () => {
    const outcome = parseCheckOutput(readCheckStdout("boundaries"));
    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") throw new Error("unreachable");
    expect(outcome.violations).toEqual([
      {
        severity: "Error",
        rule: "boundary",
        message: "Boundary violation: src/core/uses_app.ts imports src/app/helper.ts — core must not import app-specific helpers",
        files: ["src/core/uses_app.ts", "src/app/helper.ts"],
      },
    ]);
  });

  it("p0l-layers: layer_direction violation, higher-order importing lower-order", () => {
    const outcome = parseCheckOutput(readCheckStdout("p0l-layers"));
    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") throw new Error("unreachable");
    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0].rule).toBe("layer_direction");
    expect(outcome.violations[0].files).toEqual(["src/app/uses_core.ts", "src/core/base.ts"]);
  });

  it("ablation: boolean constraint false is not counted, pass", () => {
    expect(parseCheckOutput(readCheckStdout("abl1-no_god_files_false"))).toEqual({
      kind: "pass",
      rulesChecked: 0,
      quality: 4674,
    });
  });

  it("ablation: boolean constraint true is counted, 1 violation", () => {
    const outcome = parseCheckOutput(readCheckStdout("abl2-no_god_files_true"));
    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") throw new Error("unreachable");
    expect(outcome.rulesChecked).toBe(1);
    expect(outcome.violations).toHaveLength(1);
  });

  it("ablation: numeric constraint alone is always counted, pass", () => {
    expect(parseCheckOutput(readCheckStdout("abl3-min_quality_alone"))).toEqual({
      kind: "pass",
      rulesChecked: 1,
      quality: 4674,
    });
  });

  it("missing-rules: empty stdout is unparseable", () => {
    expect(parseCheckOutput(readFileSync(join(FIXTURES, "check", "missing-rules", "stdout.txt"), "utf8"))).toEqual({
      kind: "unparseable",
    });
  });

  it("invalid-toml: empty stdout is unparseable", () => {
    expect(parseCheckOutput(readFileSync(join(FIXTURES, "check", "invalid-toml", "stdout.txt"), "utf8"))).toEqual({
      kind: "unparseable",
    });
  });

  it("completely empty stdout is unparseable", () => {
    expect(parseCheckOutput("")).toEqual({ kind: "unparseable" });
  });

  it("parses a ⚠ [Warning] violation (unconfirmed by real captures, still supported)", () => {
    const stdout = ["sentrux check — 1 rules checked", "", "Quality: 5000", "", "⚠ [Warning] some_rule: a soft warning", "    src/a.ts", "", "⚠ 1 violation(s) found"].join("\n");
    const outcome = parseCheckOutput(stdout);
    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") throw new Error("unreachable");
    expect(outcome.violations).toEqual([{ severity: "Warning", rule: "some_rule", message: "a soft warning", files: ["src/a.ts"] }]);
  });

  it("is robust to CRLF line endings", () => {
    const crlf = readCheckStdout("many-rules-fail").replace(/\n/g, "\r\n");
    expect(parseCheckOutput(crlf)).toEqual(parseCheckOutput(readCheckStdout("many-rules-fail")));
  });

  it("is robust to embedded ANSI color codes", () => {
    const ansi = readCheckStdout("many-rules-pass").replace("All rules pass", "\x1b[32mAll rules pass\x1b[0m");
    expect(parseCheckOutput(ansi)).toEqual({ kind: "pass", rulesChecked: 4, quality: 4674 });
  });
});

describe("parseGateSaveOutput — Phase 0 fixtures", () => {
  it("gate/save: baseline path and quality", () => {
    expect(parseGateSaveOutput(readGateStdout("save"))).toEqual({
      kind: "saved",
      baselinePath: "/tmp/sentrux-p0-gate/.sentrux/baseline.json",
      quality: 4674,
    });
  });

  it("empty stdout is unparseable", () => {
    expect(parseGateSaveOutput("")).toEqual({ kind: "unparseable" });
  });
});

describe("parseGateCompareOutput — Phase 0 fixtures", () => {
  it("gate/ok: no degradation", () => {
    expect(parseGateCompareOutput(readGateStdout("ok"))).toEqual({
      kind: "ok",
      quality: { before: 4674, after: 4674 },
      coupling: { before: 0.91, after: 0.91 },
      cycles: { before: 1, after: 1 },
      godFiles: { before: 1, after: 1 },
      distance: undefined,
      reasons: [],
    });
  });

  it("gate/degraded: reasons parsed in order", () => {
    expect(parseGateCompareOutput(readGateStdout("degraded"))).toEqual({
      kind: "degraded",
      quality: { before: 4674, after: 4349 },
      coupling: { before: 0.91, after: 0.83 },
      cycles: { before: 1, after: 2 },
      godFiles: { before: 1, after: 1 },
      distance: undefined,
      reasons: ["Quality signal dropped: 0.47 → 0.43 (-0.03)", "Cycles increased: 1 → 2"],
    });
  });

  it("gate/missing-baseline: empty stdout is unparseable", () => {
    expect(parseGateCompareOutput(readFileSync(join(FIXTURES, "gate", "missing-baseline", "stdout.txt"), "utf8"))).toEqual({
      kind: "unparseable",
    });
  });

  it("parses the optional Distance from Main Sequence line when present", () => {
    const stdout = [
      "sentrux gate — structural regression check",
      "",
      "Quality:      4674 -> 4674",
      "Coupling:     0.91 → 0.91",
      "Cycles:       1 → 1",
      "God files:    1 → 1",
      "Distance from Main Sequence: 0.12",
      "",
      "✓ No degradation detected",
    ].join("\n");
    const outcome = parseGateCompareOutput(stdout);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "unparseable") throw new Error("unreachable");
    expect(outcome.distance).toBe(0.12);
  });

  it("accepts either arrow style (-> or →) in any metric field", () => {
    const stdout = [
      "sentrux gate — structural regression check",
      "",
      "Quality:      4674 → 4674",
      "Coupling:     0.91 -> 0.91",
      "Cycles:       1 -> 1",
      "God files:    1 → 1",
      "",
      "✓ No degradation detected",
    ].join("\n");
    expect(parseGateCompareOutput(stdout)).toEqual({
      kind: "ok",
      quality: { before: 4674, after: 4674 },
      coupling: { before: 0.91, after: 0.91 },
      cycles: { before: 1, after: 1 },
      godFiles: { before: 1, after: 1 },
      distance: undefined,
      reasons: [],
    });
  });

  it("is robust to CRLF line endings", () => {
    const crlf = readGateStdout("degraded").replace(/\n/g, "\r\n");
    expect(parseGateCompareOutput(crlf)).toEqual(parseGateCompareOutput(readGateStdout("degraded")));
  });

  it("is robust to embedded ANSI color codes", () => {
    const ansi = readGateStdout("degraded").replace("DEGRADED", "\x1b[31mDEGRADED\x1b[0m");
    const outcome = parseGateCompareOutput(ansi);
    expect(outcome.kind).toBe("degraded");
  });

  it("empty stdout is unparseable", () => {
    expect(parseGateCompareOutput("")).toEqual({ kind: "unparseable" });
  });
});
