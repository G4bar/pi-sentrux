import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendNoteWithinBudget,
  buildModelText,
  capThrownMessage,
  formatDsm,
  formatGitStats,
  formatScanHealth,
  formatSessionEnd,
  formatTestGaps,
  formatUnknownFields,
  MAX_THROWN_ERROR_CHARS,
  spillFileName,
  type DsmResult,
  type GitStatsResult,
  type HealthResult,
  type ScanResult,
  type SessionEndResult,
  type TestGapsResult,
} from "../../extensions/sentrux/format.ts";

describe("formatUnknownFields", () => {
  it("prints scalar fields not in knownKeys, and skips known/non-scalar fields", () => {
    const withExtra = {
      coupling_change: [0.9, 0.9] as [number, number],
      cycles_change: [1, 1] as [number, number],
      pass: true,
      signal_after: 4674,
      signal_before: 4674,
      signal_delta: 0,
      summary: "ok",
      violations: [] as unknown[],
      pro_extra_metric: 42,
      pro_flag: true,
    };
    const lines = formatUnknownFields(withExtra, [
      "coupling_change",
      "cycles_change",
      "pass",
      "signal_after",
      "signal_before",
      "signal_delta",
      "summary",
      "violations",
    ]);
    expect(lines).toEqual(["pro_extra_metric: 42", "pro_flag: true"]);
  });
});

describe("formatScanHealth", () => {
  const scan: ScanResult = { files: 29, import_edges: 22, lines: 107, quality_signal: 4674, scanned: "/tmp/sentrux-p0c-fail" };
  const health: HealthResult = {
    bottleneck: "redundancy",
    cross_module_edges: 20,
    quality_signal: 4674,
    root_causes: {
      acyclicity: { raw: 1, score: 5000 },
      depth: { raw: 1, score: 8889 },
      equality: { raw: 0.5729166666666666, score: 4271 },
      modularity: { raw: 0.028925619834710738, score: 3526 },
      redundancy: { raw: 0.6666666666666666, score: 3333 },
    },
    total_import_edges: 22,
    upgrade: { message: "Upgrade to Pro for root-cause diagnostics: https://github.com/sentrux/sentrux" },
  };

  it("prints quality/bottleneck, each root cause's score with its labeled raw value, and size counts", () => {
    const text = formatScanHealth("/abs/repo", scan, health);
    expect(text).toContain("Sentrux quality 4674/10000 — bottleneck: redundancy  (root /abs/repo)");
    expect(text).toContain("modularity 3526 (Q=0.028925619834710738)");
    expect(text).toContain("acyclicity 5000 (cycles=1)");
    expect(text).toContain("depth 8889 (max depth=1)");
    expect(text).toContain("equality 4271 (Gini=0.5729166666666666)");
    expect(text).toContain("redundancy 3333 (ratio=0.6666666666666666)");
    expect(text).toContain("files 29 · lines 107 · import edges 22 (cross-module 20)");
  });

  it("keeps the upgrade message out of the text, mentioning only (free tier)", () => {
    const text = formatScanHealth("/abs/repo", scan, health);
    expect(text).toContain("(free tier)");
    expect(text).not.toContain("Upgrade to Pro");
    expect(text).not.toContain("github.com");
  });

  it("omits the free-tier note when upgrade is absent", () => {
    const proHealth: HealthResult = { ...health, upgrade: undefined };
    const text = formatScanHealth("/abs/repo", scan, proHealth);
    expect(text).not.toContain("(free tier)");
  });
});

describe("formatSessionEnd", () => {
  it("formats a passing session_end with zero deltas and the summary", () => {
    const result: SessionEndResult = {
      coupling_change: [0.9090909090909091, 0.9090909090909091],
      cycles_change: [1, 1],
      pass: true,
      signal_after: 4674,
      signal_before: 4674,
      signal_delta: 0,
      summary: "Quality stable or improved",
      violations: [],
    };
    const text = formatSessionEnd(result);
    expect(text).toContain("session: PASS  quality 4674 → 4674 (0) · coupling 0 · cycles 0");
    expect(text).toContain("Quality stable or improved");
    expect(text).not.toContain("violations");
  });

  it("formats a degraded session_end with signed deltas and lists violations", () => {
    const result: SessionEndResult = {
      coupling_change: [0.4, 0.44],
      cycles_change: [1, 2],
      pass: false,
      signal_after: 7120,
      signal_before: 7342,
      signal_delta: -222,
      summary: "Quality degraded",
      violations: ["new import cycle: a.ts <-> b.ts"],
    };
    const text = formatSessionEnd(result);
    expect(text).toContain("session: DEGRADED  quality 7342 → 7120 (-222) · coupling +0.04 · cycles +1");
    expect(text).toContain("violations (1):");
    expect(text).toContain("  - new import cycle: a.ts <-> b.ts");
    expect(text).toContain("Quality degraded");
  });
});

describe("formatDsm", () => {
  const result: DsmResult = {
    above_diagonal: 0,
    below_diagonal: 20,
    clusters: [{ files_count: 2, internal_edges: 2, level: 0 }],
    density: 313,
    edge_count: 22,
    interpretation: "Clean layering: all dependencies flow downward",
    level_breaks: 1,
    propagation_cost: 313,
    same_level: 2,
    size: 27,
  };

  it("prints size/density/diagonal/level counts, the interpretation, and clusters (present in the free tier)", () => {
    const text = formatDsm(result);
    expect(text).toContain("size: 27");
    expect(text).toContain("density: 313");
    expect(text).toContain("above_diagonal: 0");
    expect(text).toContain("below_diagonal: 20");
    expect(text).toContain("interpretation: Clean layering: all dependencies flow downward");
    expect(text).toContain("clusters: 1");
    expect(text).toContain("level 0: 2 files, 2 internal edges");
  });

  it("notes the free tier when the matrix field is absent", () => {
    const text = formatDsm(result);
    expect(text).toContain("free tier");
  });

  it("does not note free tier, and prints the matrix generically, when matrix is present", () => {
    const proResult = { ...result, matrix: "ascii matrix here" };
    const text = formatDsm(proResult);
    expect(text).not.toContain("free tier");
  });
});

describe("formatTestGaps", () => {
  it("prints the free-tier counts and notes the free tier", () => {
    const result: TestGapsResult = { coverage_ratio: 0, coverage_score: 0, source_files: 29, test_files: 0, tested: 0, untested: 29 };
    const text = formatTestGaps(result);
    expect(text).toContain("source_files: 29");
    expect(text).toContain("untested: 29");
    expect(text).toContain("(free tier: counts only)");
  });
});

describe("formatGitStats", () => {
  it("prints the free-tier counts and notes the free tier", () => {
    const result: GitStatsResult = {
      bus_factor_solo_files: 28,
      commits_analyzed: 1,
      coupling_pairs_found: 0,
      files_with_churn: 28,
      hotspot_count: 28,
      lookback_days: 90,
      single_author_ratio: 1,
    };
    const text = formatGitStats(result);
    expect(text).toContain("lookback_days: 90");
    expect(text).toContain("bus_factor_solo_files: 28");
    expect(text).toContain("(free tier: counts only)");
  });

  it("omits the free-tier note and prints extra Pro fields generically when present", () => {
    const proResult = {
      bus_factor_solo_files: 28,
      commits_analyzed: 1,
      coupling_pairs_found: 0,
      files_with_churn: 28,
      hotspot_count: 28,
      lookback_days: 90,
      single_author_ratio: 1,
      pro_coupling_matrix: "...",
    };
    const text = formatGitStats(proResult);
    expect(text).not.toContain("free tier");
    expect(text).toContain("pro_coupling_matrix: ...");
  });
});

describe("buildModelText", () => {
  const spillPaths: string[] = [];

  afterEach(async () => {
    for (const p of spillPaths) {
      await rm(p, { force: true });
    }
    spillPaths.length = 0;
  });

  it("returns the text unchanged when under both caps", async () => {
    const text = await buildModelText({
      toolCallId: "call-1",
      text: "sentrux check: PASS (4 rules checked) · quality 4674",
      details: { status: "pass" },
      maxBytes: 8192,
      maxLines: 200,
    });
    expect(text).toBe("sentrux check: PASS (4 rules checked) · quality 4674");
  });

  it("truncates at the line cap and spills the full text+details to a temp file with a note", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const toolCallId = `call-lines-${Date.now()}`;
    const details = { violations: lines.length };
    const text = await buildModelText({ toolCallId, text: lines.join("\n"), details, maxBytes: 8192, maxLines: 200 });

    const spillPath = join(tmpdir(), "pi-sentrux", `${toolCallId}.txt`);
    spillPaths.push(spillPath);

    expect(text.split("\n").filter((l) => l.startsWith("line "))).toHaveLength(200);
    expect(text).toContain(`[truncated — full output and details written to ${spillPath}]`);

    const spilled = await readFile(spillPath, "utf8");
    expect(spilled).toContain("line 249");
    expect(spilled).toContain('"violations": 250');
  });

  it("truncates at the byte cap and spills the full text+details to a temp file with a note", async () => {
    const bigLine = "x".repeat(20_000);
    const toolCallId = `call-bytes-${Date.now()}`;
    const details = { note: "big" };
    const text = await buildModelText({ toolCallId, text: bigLine, details, maxBytes: 8192, maxLines: 200 });

    const spillPath = join(tmpdir(), "pi-sentrux", `${toolCallId}.txt`);
    spillPaths.push(spillPath);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(8192 + 200);
    expect(text).toContain(`written to ${spillPath}`);

    const spilled = await readFile(spillPath, "utf8");
    expect(spilled.startsWith("x".repeat(20_000))).toBe(true);
  });

  it("does not spill when within caps, even with multi-byte UTF-8 content", async () => {
    const text = await buildModelText({
      toolCallId: "call-utf8",
      text: "✗ [Error] max_cycles: → cycle detected",
      details: {},
      maxBytes: 8192,
      maxLines: 200,
    });
    expect(text).toBe("✗ [Error] max_cycles: → cycle detected");
  });

  it("hashes an unsafe tool-call ID instead of using it as a file name", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const toolCallId = `../../evil-${Date.now()}`;
    const fileName = spillFileName(toolCallId);
    expect(fileName).not.toContain("/");
    expect(fileName).toMatch(/^[0-9a-f]{32}\.txt$/);

    const text = await buildModelText({ toolCallId, text: lines.join("\n"), details: {}, maxBytes: 8192, maxLines: 200 });
    const spillPath = join(tmpdir(), "pi-sentrux", fileName);
    spillPaths.push(spillPath);
    expect(text).toContain(`written to ${spillPath}`);
    expect((await readFile(spillPath, "utf8"))).toContain("line 249");
  });

  it("falls back to the truncated text when the spill file cannot be written", async () => {
    const toolCallId = `call-spill-fail-${Date.now()}`;
    const spillPath = join(tmpdir(), "pi-sentrux", `${toolCallId}.txt`);
    // A directory at the spill path makes the file write fail.
    await mkdir(spillPath, { recursive: true });
    try {
      const text = await buildModelText({
        toolCallId,
        text: "y".repeat(20_000),
        details: {},
        maxBytes: 8192,
        maxLines: 200,
      });
      expect(text).not.toContain("written to");
      expect(text.length).toBeLessThan(8192);
    } finally {
      await rm(spillPath, { recursive: true, force: true });
    }
  });

  it("keeps the truncated text plus note within maxBytes", async () => {
    const bigLine = "z".repeat(20_000);
    const toolCallId = `call-budget-${Date.now()}`;
    const text = await buildModelText({ toolCallId, text: bigLine, details: {}, maxBytes: 8192, maxLines: 200 });
    spillPaths.push(join(tmpdir(), "pi-sentrux", `${toolCallId}.txt`));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
    expect(text).toContain("written to");
  });
});

describe("capThrownMessage", () => {
  it("leaves short messages unchanged", () => {
    expect(capThrownMessage("boom")).toBe("boom");
  });

  it("caps long messages at the budget with a marker", () => {
    const capped = capThrownMessage("x".repeat(MAX_THROWN_ERROR_CHARS + 100));
    expect(capped.length).toBeLessThanOrEqual(MAX_THROWN_ERROR_CHARS + 20);
    expect(capped).toContain("[truncated]");
  });
});

describe("appendNoteWithinBudget", () => {
  it("appends directly when there is room", () => {
    expect(appendNoteWithinBudget("abc", "\nnote", 100)).toBe("abc\nnote");
  });

  it("trims content so content plus note fit maxBytes", () => {
    const out = appendNoteWithinBudget("a".repeat(100), "\nnote", 50);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(50);
    expect(out.endsWith("\nnote")).toBe(true);
  });
});
