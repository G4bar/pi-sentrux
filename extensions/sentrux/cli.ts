import { run, type RunResult } from "./process.ts";
import { buildInvocationArgs } from "./binary.ts";

/** Executable to spawn for `check`/`gate`. `prefixArgs` is a test-only seam so unit tests can run
 * `node fake-sentrux.mjs ...` instead of a real binary; production callers pass only `command`. */
export interface CliCommand {
  command: string;
  prefixArgs?: string[];
}

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

function invoke(cli: CliCommand, args: string[], options: RunCliOptions): Promise<RunResult> {
  return run(cli.command, [...(cli.prefixArgs ?? []), ...args], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function runCheck(cli: CliCommand, root: string, options: RunCliOptions): Promise<RunResult> {
  return invoke(cli, buildInvocationArgs("check", root), options);
}

export function runGate(cli: CliCommand, root: string, save: boolean, options: RunCliOptions): Promise<RunResult> {
  return invoke(cli, buildInvocationArgs(save ? "gateSave" : "gate", root), options);
}

// --- pure parsers ---
// Regexes are re-validated against test/fixtures/v0.5.7/{check,gate}/*/stdout.txt (Phase 0 captures).

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strips ANSI color codes and normalizes CRLF/lone-CR to LF before parsing. */
export function normalizeCliOutput(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "");
}

const ARROW = "(?:->|\u2192)";

function stderrTail(stderr: string, maxLines = 5): string {
  const lines = stderr.split("\n").filter((line) => line.length > 0);
  return lines.slice(-maxLines).join("\n");
}

export { stderrTail };

// -- check --

const CHECK_HEADER_RE = /^sentrux check [\u2014-] (\d+) rules checked$/m;
const CHECK_QUALITY_RE = /^Quality: (\d+)$/m;
const CHECK_PASS_RE = /^\u2713 All rules pass$/m;
const VIOLATION_HEADER_RE = /^(?:\u2717|\u26a0)\s*\[(Error|Warning)\]\s*([^:]+):\s*(.*)$/;
const FILE_LINE_RE = /^ {4}(.+)$/;
const CHECK_FOOTER_RE = /^(?:\u2717|\u26a0) (\d+) violation\(s\) found$/m;

export interface CheckViolation {
  severity: "Error" | "Warning";
  rule: string;
  message: string;
  files: string[];
}

export type CheckOutcome =
  | { kind: "pass"; rulesChecked: number; quality: number }
  | { kind: "fail"; rulesChecked: number; quality: number; violations: CheckViolation[]; violationCount: number }
  | { kind: "unparseable" };

export function parseCheckOutput(stdout: string): CheckOutcome {
  const text = normalizeCliOutput(stdout);
  const headerMatch = text.match(CHECK_HEADER_RE);
  const qualityMatch = text.match(CHECK_QUALITY_RE);
  if (!headerMatch || !qualityMatch) return { kind: "unparseable" };

  const rulesChecked = Number(headerMatch[1]);
  const quality = Number(qualityMatch[1]);

  if (CHECK_PASS_RE.test(text)) {
    return { kind: "pass", rulesChecked, quality };
  }

  const violations: CheckViolation[] = [];
  let current: CheckViolation | undefined;
  for (const line of text.split("\n")) {
    const violationMatch = line.match(VIOLATION_HEADER_RE);
    if (violationMatch) {
      current = {
        severity: violationMatch[1] as "Error" | "Warning",
        rule: violationMatch[2].trim(),
        message: violationMatch[3].trim(),
        files: [],
      };
      violations.push(current);
      continue;
    }
    const fileMatch = line.match(FILE_LINE_RE);
    if (fileMatch && current) {
      current.files.push(fileMatch[1]);
    }
  }

  const footerMatch = text.match(CHECK_FOOTER_RE);
  if (!footerMatch || violations.length === 0) return { kind: "unparseable" };

  return { kind: "fail", rulesChecked, quality, violations, violationCount: Number(footerMatch[1]) };
}

// -- gate --

const GATE_SAVE_PATH_RE = /^Baseline saved to (.+)$/m;
const GATE_SAVE_QUALITY_RE = /^Quality: (\d+)$/m;

export type GateSaveOutcome = { kind: "saved"; baselinePath: string; quality: number } | { kind: "unparseable" };

export function parseGateSaveOutput(stdout: string): GateSaveOutcome {
  const text = normalizeCliOutput(stdout);
  const pathMatch = text.match(GATE_SAVE_PATH_RE);
  const qualityMatch = text.match(GATE_SAVE_QUALITY_RE);
  if (!pathMatch || !qualityMatch) return { kind: "unparseable" };
  return { kind: "saved", baselinePath: pathMatch[1].trim(), quality: Number(qualityMatch[1]) };
}

export interface MetricPair {
  before: number;
  after: number;
}

function metricPairRe(label: string): RegExp {
  return new RegExp(`^${label}:\\s+([\\d.]+)\\s*${ARROW}\\s*([\\d.]+)$`, "m");
}

const GATE_QUALITY_RE = metricPairRe("Quality");
const GATE_COUPLING_RE = metricPairRe("Coupling");
const GATE_CYCLES_RE = metricPairRe("Cycles");
const GATE_GOD_FILES_RE = metricPairRe("God files");
const GATE_DISTANCE_RE = /^Distance from Main Sequence:\s*([\d.]+)$/m;
const GATE_OK_RE = /^\u2713 No degradation detected$/m;
const GATE_DEGRADED_RE = /^\u2717 DEGRADED$/m;
const GATE_REASON_RE = /^ {2}\u2717 (.+)$/gm;

export type GateCompareOutcome =
  | {
      kind: "ok" | "degraded";
      quality: MetricPair;
      coupling: MetricPair;
      cycles: MetricPair;
      godFiles: MetricPair;
      distance?: number;
      reasons: string[];
    }
  | { kind: "unparseable" };

export function parseGateCompareOutput(stdout: string): GateCompareOutcome {
  const text = normalizeCliOutput(stdout);
  const q = text.match(GATE_QUALITY_RE);
  const c = text.match(GATE_COUPLING_RE);
  const cy = text.match(GATE_CYCLES_RE);
  const g = text.match(GATE_GOD_FILES_RE);
  if (!q || !c || !cy || !g) return { kind: "unparseable" };

  const distanceMatch = text.match(GATE_DISTANCE_RE);
  const base = {
    quality: { before: Number(q[1]), after: Number(q[2]) },
    coupling: { before: Number(c[1]), after: Number(c[2]) },
    cycles: { before: Number(cy[1]), after: Number(cy[2]) },
    godFiles: { before: Number(g[1]), after: Number(g[2]) },
    distance: distanceMatch ? Number(distanceMatch[1]) : undefined,
  };

  if (GATE_OK_RE.test(text)) {
    return { kind: "ok", ...base, reasons: [] };
  }
  if (GATE_DEGRADED_RE.test(text)) {
    const reasons = [...text.matchAll(GATE_REASON_RE)].map((m) => m[1].trim());
    return { kind: "degraded", ...base, reasons };
  }
  return { kind: "unparseable" };
}
