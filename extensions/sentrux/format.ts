import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

// --- MCP result shapes (Phase 0, free tier; see test/fixtures/v0.5.7/mcp/transcript*.jsonl) ---

export interface ScanResult {
  files: number;
  import_edges: number;
  lines: number;
  quality_signal: number;
  scanned: string;
}

export interface RootCause {
  raw: number;
  score: number;
}

export interface HealthResult {
  bottleneck: string;
  cross_module_edges: number;
  quality_signal: number;
  root_causes: Record<string, RootCause>;
  total_import_edges: number;
  upgrade?: { message: string };
}

export interface SessionStartResult {
  message: string;
  quality_signal: number;
  status: string;
}

export interface SessionEndResult {
  coupling_change: [number, number];
  cycles_change: [number, number];
  pass: boolean;
  signal_after: number;
  signal_before: number;
  signal_delta: number;
  summary: string;
  violations: unknown[];
}

export interface DsmCluster {
  files_count: number;
  internal_edges: number;
  level: number;
}

export interface DsmResult {
  above_diagonal: number;
  below_diagonal: number;
  clusters?: DsmCluster[];
  density: number;
  edge_count?: number;
  interpretation: string;
  level_breaks: number;
  propagation_cost: number;
  same_level?: number;
  size: number;
  /** Pro-only: the ASCII matrix itself (format="text"). Absent in the free tier. */
  matrix?: unknown;
}

export interface TestGapsResult {
  coverage_ratio: number;
  coverage_score: number;
  source_files: number;
  test_files: number;
  tested: number;
  untested: number;
}

export interface GitStatsResult {
  bus_factor_solo_files: number;
  commits_analyzed: number;
  coupling_pairs_found: number;
  files_with_churn: number;
  hotspot_count: number;
  lookback_days: number;
  single_author_ratio: number;
}

type UnknownFieldsSource = HealthResult | SessionEndResult | DsmResult | TestGapsResult | GitStatsResult;

/** Rounds a float to 3 significant figures for model text (Gini=0.4590644753476612
 * becomes 0.459). Integers (scores, counts) pass through untouched — rounding must
 * never quantize the primary 0–10000 scale. */
export function formatNum(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;
  return Number(value.toPrecision(3));
}

/** Prints any top-level scalar (string/number/boolean) field not in `knownKeys` as `key: value`,
 * so Pro-tier fields the free-tier fixtures don't have still show up instead of being dropped. */
export function formatUnknownFields(obj: UnknownFieldsSource, knownKeys: readonly string[]): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (knownKeys.includes(key)) continue;
    if (typeof value === "string" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${formatNum(value)}`);
    }
  }
  return lines;
}

const ROOT_CAUSE_ORDER = ["modularity", "acyclicity", "depth", "equality", "redundancy"] as const;

/** raw's meaning per root cause (§ PLAN.md "Real MCP result shapes"): acyclicity=cycle count,
 * depth=max depth, equality=Gini coefficient, modularity=Q, redundancy=(dead+duplicate)/total. */
const ROOT_CAUSE_RAW_LABELS: Record<(typeof ROOT_CAUSE_ORDER)[number], string> = {
  modularity: "Q",
  acyclicity: "cycles",
  depth: "max depth",
  equality: "Gini",
  redundancy: "ratio",
};

const KNOWN_HEALTH_KEYS = ["bottleneck", "cross_module_edges", "quality_signal", "root_causes", "total_import_edges", "upgrade"];

/** Combined `scan` + `health` text for sentrux_scan. Keeps the Pro `upgrade` message out of the
 * model text (mentions only "(free tier)") and labels each root cause's raw value by its meaning. */
export function formatScanHealth(root: string, scan: ScanResult, health: HealthResult): string {
  const lines: string[] = [`Sentrux quality ${health.quality_signal}/10000 — bottleneck: ${health.bottleneck}  (root ${root})`];

  const rootCauseParts: string[] = [];
  for (const name of ROOT_CAUSE_ORDER) {
    const rc = health.root_causes[name];
    if (!rc) continue;
    rootCauseParts.push(`${name} ${rc.score} (${ROOT_CAUSE_RAW_LABELS[name]}=${formatNum(rc.raw)})`);
  }
  if (rootCauseParts.length > 0) lines.push(rootCauseParts.join(" · "));

  lines.push(
    `files ${scan.files} · lines ${scan.lines.toLocaleString()} · import edges ${scan.import_edges} (cross-module ${health.cross_module_edges})`,
  );
  if (health.upgrade) lines.push("(free tier)");
  lines.push(...formatUnknownFields(health, KNOWN_HEALTH_KEYS));
  return lines.join("\n");
}

function formatSignedDelta(delta: number, decimals: number): string {
  const rounded = Number(delta.toFixed(decimals));
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function formatPairDelta(pair: [number, number], decimals: number): string {
  return formatSignedDelta(pair[1] - pair[0], decimals);
}

const KNOWN_SESSION_END_KEYS = ["coupling_change", "cycles_change", "pass", "signal_after", "signal_before", "signal_delta", "summary", "violations"];

/** `session_end` text for sentrux_session. Repeatable: always compares against the recorded start.
 * Quality/scores are the primary 0–10000 scale; coupling is Sentrux's 0–1 scale and is labeled. */
export function formatSessionEnd(result: SessionEndResult): string {
  const label = result.pass ? "PASS" : "DEGRADED";
  const lines = [
    `session: ${label}  quality ${result.signal_before} → ${result.signal_after} (${formatSignedDelta(result.signal_delta, 0)}) · ` +
      `coupling ${formatPairDelta(result.coupling_change, 2)} (0–1 scale) · cycles ${formatPairDelta(result.cycles_change, 0)}`,
  ];
  if (result.violations.length > 0) {
    lines.push(`violations (${result.violations.length}):`);
    for (const v of result.violations) lines.push(`  - ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  lines.push(result.summary);
  lines.push(...formatUnknownFields(result, KNOWN_SESSION_END_KEYS));
  return lines.join("\n");
}

const DSM_KNOWN_KEYS = [
  "above_diagonal",
  "below_diagonal",
  "clusters",
  "density",
  "edge_count",
  "interpretation",
  "level_breaks",
  "propagation_cost",
  "same_level",
  "size",
  "matrix",
];

/** `dsm` text for sentrux_insights. `clusters` IS present in the free tier; the matrix itself is Pro-only.
 * `density`/`propagation_cost` print raw (their scale is unverified — never invent a unit).
 * When the caller passes the current cycle count and it is > 0 while Sentrux's own
 * interpretation still claims clean layering, a note says so (the interpretation is
 * Sentrux's verbatim text and can contradict the measured cycles). */
export function formatDsm(result: DsmResult, opts: { cycles?: number } = {}): string {
  const lines: string[] = [];
  const order: (keyof DsmResult)[] = ["size", "density", "above_diagonal", "below_diagonal", "same_level", "level_breaks", "propagation_cost", "edge_count"];
  for (const key of order) {
    const value = result[key];
    if (value === undefined) continue;
    lines.push(`${key}: ${typeof value === "number" ? formatNum(value) : value}`);
  }
  if (result.interpretation) lines.push(`interpretation: ${result.interpretation}`);
  if (opts.cycles !== undefined && opts.cycles > 0 && result.interpretation && /clean layering/i.test(result.interpretation)) {
    const noun = opts.cycles === 1 ? "cycle" : "cycles";
    lines.push(`(note: interpretation is Sentrux's own; health currently reports ${opts.cycles} ${noun})`);
  }
  if (result.clusters && result.clusters.length > 0) {
    lines.push(`clusters: ${result.clusters.length}`);
    for (const c of result.clusters) lines.push(`  level ${c.level}: ${c.files_count} files, ${c.internal_edges} internal edges`);
  }
  lines.push(...formatUnknownFields(result, DSM_KNOWN_KEYS));
  if (result.matrix === undefined) lines.push("(free tier: counts only — the matrix itself is Pro-only)");
  return lines.join("\n");
}

const TEST_GAPS_KNOWN_KEYS = ["coverage_ratio", "coverage_score", "source_files", "test_files", "tested", "untested"];

/** `test_gaps` text for sentrux_insights. `coverage_ratio` is the 0–10000-scale
 * figure (observed 3939 next to `coverage_score` 0.3939 on a real run) and prints
 * bare like every other primary-scale number; `coverage_score` is Sentrux's 0–1
 * scale and is labeled. */
export function formatTestGaps(result: TestGapsResult): string {
  const lines: string[] = [];
  if (result.source_files !== undefined) lines.push(`source_files: ${result.source_files}`);
  if (result.test_files !== undefined) lines.push(`test_files: ${result.test_files}`);
  if (result.tested !== undefined) lines.push(`tested: ${result.tested}`);
  if (result.untested !== undefined) lines.push(`untested: ${result.untested}`);
  if (result.coverage_ratio !== undefined) lines.push(`coverage_ratio: ${formatNum(result.coverage_ratio)}`);
  if (result.coverage_score !== undefined) lines.push(`coverage_score: ${formatNum(result.coverage_score)} (0–1 scale)`);
  const extra = formatUnknownFields(result, TEST_GAPS_KNOWN_KEYS);
  lines.push(...extra);
  if (extra.length === 0) lines.push("(free tier: counts only)");
  return lines.join("\n");
}

const GIT_STATS_KNOWN_KEYS = [
  "bus_factor_solo_files",
  "commits_analyzed",
  "coupling_pairs_found",
  "files_with_churn",
  "hotspot_count",
  "lookback_days",
  "single_author_ratio",
];

/** `git_stats` text for sentrux_insights. */
export function formatGitStats(result: GitStatsResult): string {
  const order: (keyof GitStatsResult)[] = [
    "lookback_days",
    "commits_analyzed",
    "files_with_churn",
    "hotspot_count",
    "coupling_pairs_found",
    "bus_factor_solo_files",
    "single_author_ratio",
  ];
  const lines = order
    .filter((key) => result[key] !== undefined)
    .map((key) => `${key}: ${formatNum(result[key] as number)}`);
  const extra = formatUnknownFields(result, GIT_STATS_KNOWN_KEYS);
  lines.push(...extra);
  if (extra.length === 0) lines.push("(free tier: counts only)");
  return lines.join("\n");
}

/** Hard cap for error messages thrown toward the model. The host passes
 * `error.message` verbatim, so an uncapped message (an 8 KB stderr tail, a full
 * CLI stdout) would bypass the `maxOutputBytes` budget entirely. */
export const MAX_THROWN_ERROR_CHARS = 8000;

export function capThrownMessage(message: string): string {
  if (message.length <= MAX_THROWN_ERROR_CHARS) return message;
  return `${message.slice(0, MAX_THROWN_ERROR_CHARS)}\u2026 [truncated]`;
}

export interface BuildModelTextOptions {
  toolCallId: string;
  text: string;
  details: unknown;
  maxBytes: number;
  maxLines: number;
}

/** The tool-call ID comes from the provider unsanitized, so only filesystem-safe
 * IDs are used verbatim; anything else is hashed to a fixed-length safe name. */
export function spillFileName(toolCallId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(toolCallId)) return `${toolCallId}.txt`;
  return `${createHash("sha256").update(toolCallId).digest("hex").slice(0, 32)}.txt`;
}

/** Appends `note` to `content` without exceeding `maxBytes`: trims whole bytes off
 * the content first so the truncation note itself cannot push the text over budget. */
export function appendNoteWithinBudget(content: string, note: string, maxBytes: number): string {
  const over = Buffer.byteLength(content, "utf8") + Buffer.byteLength(note, "utf8") - maxBytes;
  if (over <= 0) return `${content}${note}`;
  const contentBytes = Buffer.byteLength(content, "utf8");
  const trimmed = Buffer.from(content, "utf8").subarray(0, Math.max(0, contentBytes - over)).toString("utf8");
  return `${trimmed}${note}`;
}

/** Truncates `text` to the config caps; when truncated, spills the full text and details JSON to
 * os.tmpdir()/pi-sentrux/<toolCallId>.txt (serialized per-file via withFileMutationQueue) and
 * appends a note with that path. The spill directory is 0700 and the file 0600; a spill
 * write failure falls back to the truncated text so a computed result is never lost. */
export async function buildModelText(options: BuildModelTextOptions): Promise<string> {
  const result = truncateHead(options.text, { maxBytes: options.maxBytes, maxLines: options.maxLines });
  if (!result.truncated) return result.content;

  const spillPath = join(tmpdir(), "pi-sentrux", spillFileName(options.toolCallId));
  const spillBody = `${options.text}\n\n--- details (JSON) ---\n${JSON.stringify(options.details, null, 2)}\n`;
  try {
    await withFileMutationQueue(spillPath, async () => {
      await mkdir(dirname(spillPath), { recursive: true, mode: 0o700 });
      try {
        await writeFile(spillPath, spillBody, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
        // Same tool-call ID re-ran (e.g. a retry): overwrite the earlier spill.
        await writeFile(spillPath, spillBody, { encoding: "utf8", mode: 0o600 });
      }
    });
  } catch {
    return result.content;
  }

  const note = `\n\n[truncated \u2014 full output and details written to ${spillPath}]`;
  return appendNoteWithinBudget(result.content, note, options.maxBytes);
}
