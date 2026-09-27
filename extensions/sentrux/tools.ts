import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { resolveBinary, type BinaryStatus, type ParsedVersion } from "./binary.ts";
import {
  runCheck,
  runGate,
  parseCheckOutput,
  parseGateCompareOutput,
  parseGateSaveOutput,
  stderrTail,
  type CheckViolation,
  type CliCommand,
  type GateCompareOutcome,
} from "./cli.ts";
import { DEFAULT_CONFIG, sentruxChildEnv, type SentruxConfig } from "./config.ts";
import {
  buildModelText,
  capThrownMessage,
  formatDsm,
  formatGitStats,
  formatScanHealth,
  formatSessionEnd,
  formatTestGaps,
  type DsmResult,
  type GitStatsResult,
  type HealthResult,
  type ScanResult,
  type SessionEndResult,
  type SessionStartResult,
  type TestGapsResult,
} from "./format.ts";
import { findUntrackedFiles, formatUntrackedWarning } from "./git.ts";
import type { RunResult } from "./process.ts";
import type { McpServerRegistry } from "./servers.ts";

export interface SentruxToolDeps {
  getConfig: () => SentruxConfig | undefined;
  agentDir: string;
  /** Test-only seam: overrides the `run` used by resolveBinary's `--version` check. */
  resolveBinaryRun?: Parameters<typeof resolveBinary>[0]["run"];
  /** Test-only seam: overrides the executable used for the `check`/`gate` invocation.
   * Defaults to `{command: binaryStatus.path}` (the resolved binary, no prefix args). */
  cli?: CliCommand;
}

/** Deps for the MCP-backed tools (sentrux_scan, sentrux_session, sentrux_insights), which talk to
 * the sentrux mcp server through the shared per-root registry instead of spawning a CLI process. */
export interface SentruxMcpToolDeps extends SentruxToolDeps {
  registry: McpServerRegistry;
}

const PathParam = Type.Optional(
  Type.String({ description: "Directory to analyze (absolute or relative to the working directory). Default: working directory." }),
);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveRoot(cwd: string, path: string | undefined): Promise<string> {
  const raw = path ? resolve(cwd, path) : cwd;
  let real: string;
  try {
    real = await realpath(raw);
  } catch {
    throw new Error(`Not a directory: ${raw}`);
  }
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(real);
  } catch {
    throw new Error(`Not a directory: ${real}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${real}`);
  }
  return real;
}

function formatVersion(v: ParsedVersion): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pro ? " (Pro)" : ""}`;
}

async function resolveCli(deps: SentruxToolDeps, config: SentruxConfig): Promise<{ binaryStatus: BinaryStatus; cli: CliCommand }> {
  const binaryStatus = await resolveBinary({
    configuredPath: config.binaryPath,
    env: process.env,
    agentDir: deps.agentDir,
    cliTimeoutMs: config.cliTimeoutMs,
    run: deps.resolveBinaryRun,
  });
  const cli = deps.cli ?? { command: binaryStatus.path };
  return { binaryStatus, cli };
}

async function untrackedWarningLine(root: string, config: SentruxConfig): Promise<string | undefined> {
  if (!config.untrackedWarning) return undefined;
  const { files } = await findUntrackedFiles(root);
  return formatUntrackedWarning(files);
}

function stdoutTail(stdout: string, maxChars = 2000): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  return trimmed.length > maxChars ? `\u2026${trimmed.slice(-maxChars)}` : trimmed;
}

/** Detail suffix for a failed CLI run: the stderr tail plus a stdout tail, capped for the model. */
function cliFailureDetail(result: RunResult): string {
  const err = stderrTail(result.stderr) || "(no stderr output)";
  const out = stdoutTail(result.stdout);
  return capThrownMessage(out ? `${err}\nstdout (tail): ${out}` : err);
}

/** A timeout or abort kills the CLI process, so the exit code and partial stdout are
 * meaningless — report what actually happened instead of a generic failure. */
function throwIfCliHalted(tool: string, result: RunResult, timeoutMs: number): void {
  if (result.aborted) {
    throw new Error(capThrownMessage(`${tool} aborted: ${stderrTail(result.stderr) || "(no stderr output)"}`));
  }
  if (result.timedOut) {
    throw new Error(capThrownMessage(`${tool} timed out after ${timeoutMs}ms: ${stderrTail(result.stderr) || "(no stderr output)"}`));
  }
}

// --- sentrux_check_rules ---

const CheckRulesParams = Type.Object(
  {
    path: PathParam,
    maxFilesPerViolation: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        default: 20,
        description: "Maximum files listed per violation in the returned text before truncating to '... N more files'.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface CheckRulesDetails {
  root: string;
  binary: { path: string; version: string };
  status: "pass" | "fail" | "no_rules";
  rulesChecked: number | null;
  quality: number | null;
  violations: CheckViolation[];
}

function formatViolationForModel(v: CheckViolation, maxFiles: number): string {
  const lines = [`✗ [${v.severity}] ${v.rule}: ${v.message}`];
  const shown = v.files.slice(0, maxFiles);
  for (const f of shown) lines.push(`    ${f}`);
  if (v.files.length > maxFiles) lines.push(`    … ${v.files.length - maxFiles} more files`);
  return lines.join("\n");
}

export function registerCheckRulesTool(pi: ExtensionAPI, deps: SentruxToolDeps): void {
  pi.registerTool({
    name: "sentrux_check_rules",
    label: "Sentrux: check rules",
    description:
      "Check the directory against its .sentrux/rules.toml architecture rules (constraints, layers, boundaries) with `sentrux check` (read-only; all rules, no tier cap). Returns pass/fail, the rule count, the quality score and each violation with its files. If no rules file exists, says so. Consult the sentrux skill for the rules.toml keys.",
    promptSnippet: "Check .sentrux/rules.toml architecture rules",
    parameters: CheckRulesParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      const config = deps.getConfig() ?? DEFAULT_CONFIG;
      const root = await resolveRoot(ctx.cwd, params.path);
      const maxFilesPerViolation = params.maxFilesPerViolation ?? 20;

      const { binaryStatus, cli } = await resolveCli(deps, config);
      const warning = await untrackedWarningLine(root, config);
      const rulesPath = join(root, ".sentrux", "rules.toml");

      if (!(await pathExists(rulesPath))) {
        const lines = [
          "sentrux check: no .sentrux/rules.toml found — create one to define architecture rules.",
          "See the sentrux skill for the rules.toml keys and a starter template.",
        ];
        if (warning) lines.push(warning);
        const details: CheckRulesDetails = {
          root,
          binary: { path: binaryStatus.path, version: formatVersion(binaryStatus.version) },
          status: "no_rules",
          rulesChecked: null,
          quality: null,
          violations: [],
        };
        const text = await buildModelText({
          toolCallId,
          text: lines.join("\n"),
          details,
          maxBytes: config.maxOutputBytes,
          maxLines: config.maxOutputLines,
        });
        return { content: [{ type: "text", text }], details };
      }

      const result = await runCheck(cli, root, { cwd: root, timeoutMs: config.cliTimeoutMs, signal, env: sentruxChildEnv(config) });
      throwIfCliHalted("sentrux check", result, config.cliTimeoutMs);
      const outcome = parseCheckOutput(result.stdout);

      // Classification trusts the parsed stdout summary, not the exit code: exit 1 means
      // both "violations found" and "error", so the code alone cannot distinguish them.
      let status: "pass" | "fail";
      if (outcome.kind === "pass") {
        status = "pass";
      } else if (outcome.kind === "fail") {
        status = "fail";
      } else if (result.stderr.includes("Failed to parse")) {
        const line = result.stderr.split("\n").find((l) => l.includes("Failed to parse")) ?? result.stderr.trim();
        throw new Error(`Invalid .sentrux/rules.toml: ${line}`);
      } else {
        throw new Error(`sentrux check failed: ${cliFailureDetail(result)}`);
      }

      const rulesChecked = outcome.rulesChecked;
      const quality = outcome.quality;
      const violations = outcome.kind === "fail" ? outcome.violations : [];
      const violationCount = outcome.kind === "fail" ? outcome.violationCount : violations.length;

      const lines: string[] = [];
      if (status === "pass") {
        lines.push(`sentrux check: PASS (${rulesChecked} rules checked) · quality ${quality}`);
      } else {
        lines.push(`sentrux check: FAIL — ${violationCount} violation(s) (${rulesChecked} rules checked) · quality ${quality}`);
        for (const v of violations) lines.push(formatViolationForModel(v, maxFilesPerViolation));
      }
      if (warning) lines.push(warning);

      const details: CheckRulesDetails = {
        root,
        binary: { path: binaryStatus.path, version: formatVersion(binaryStatus.version) },
        status,
        rulesChecked,
        quality,
        violations,
      };
      const text = await buildModelText({
        toolCallId,
        text: lines.join("\n"),
        details,
        maxBytes: config.maxOutputBytes,
        maxLines: config.maxOutputLines,
      });
      return { content: [{ type: "text", text }], details };
    },
  });
}

// --- sentrux_gate ---

const GateParams = Type.Object(
  {
    path: PathParam,
    save: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "When true, WRITES .sentrux/baseline.json with the current metrics (blocked when allowBaselineWrite is false). When false (default), compares against the existing baseline.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface GateMetrics {
  before: number;
  after: number;
}

export interface GateDetails {
  root: string;
  binary: { path: string; version: string };
  status: "saved" | "ok" | "degraded" | "no_baseline";
  baselinePath: string;
  quality?: GateMetrics;
  coupling?: GateMetrics;
  cycles?: GateMetrics;
  godFiles?: GateMetrics;
  distance?: number;
  reasons?: string[];
  baseline?: unknown;
}

async function finishGateCompare(
  status: "ok" | "degraded",
  outcome: Extract<GateCompareOutcome, { kind: "ok" | "degraded" }>,
  root: string,
  binaryStatus: BinaryStatus,
  baselinePath: string,
  warning: string | undefined,
  config: SentruxConfig,
  toolCallId: string,
): Promise<AgentToolResult<GateDetails>> {
  const label = status === "ok" ? "OK" : "DEGRADED";
  const lines = [
    `sentrux gate: ${label} vs .sentrux/baseline.json`,
    `quality ${outcome.quality.before} → ${outcome.quality.after} · coupling ${outcome.coupling.before} → ${outcome.coupling.after} · ` +
      `cycles ${outcome.cycles.before} → ${outcome.cycles.after} · god files ${outcome.godFiles.before} → ${outcome.godFiles.after}`,
  ];
  if (outcome.distance !== undefined) {
    lines.push(`distance from main sequence: ${outcome.distance}`);
  }
  if (status === "degraded") {
    lines.push(`reasons: ${outcome.reasons.join("; ")}`);
  }
  if (warning) lines.push(warning);

  const details: GateDetails = {
    root,
    binary: { path: binaryStatus.path, version: formatVersion(binaryStatus.version) },
    status,
    baselinePath,
    quality: outcome.quality,
    coupling: outcome.coupling,
    cycles: outcome.cycles,
    godFiles: outcome.godFiles,
    distance: outcome.distance,
    reasons: status === "degraded" ? outcome.reasons : undefined,
  };
  const text = await buildModelText({
    toolCallId,
    text: lines.join("\n"),
    details,
    maxBytes: config.maxOutputBytes,
    maxLines: config.maxOutputLines,
  });
  return { content: [{ type: "text", text }], details };
}

export function registerGateTool(pi: ExtensionAPI, deps: SentruxToolDeps): void {
  pi.registerTool({
    name: "sentrux_gate",
    label: "Sentrux: gate",
    description:
      "On-disk structural regression gate (`sentrux gate`). save=true WRITES .sentrux/baseline.json with the current metrics; save=false (default) compares the current code with that baseline and reports degradation (quality drop >200 points, coupling +0.05, more cycles, more god files, or more functions with complexity >15). The baseline persists across sessions; use sentrux_session for an in-memory before/after.",
    promptSnippet: "Save or compare a persistent on-disk quality baseline",
    parameters: GateParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      const config = deps.getConfig() ?? DEFAULT_CONFIG;
      const root = await resolveRoot(ctx.cwd, params.path);
      const save = params.save ?? false;

      const { binaryStatus, cli } = await resolveCli(deps, config);
      const warning = await untrackedWarningLine(root, config);
      const baselinePath = join(root, ".sentrux", "baseline.json");

      if (save) {
        if (!config.allowBaselineWrite) {
          throw new Error("Writing .sentrux/baseline.json is disabled (allowBaselineWrite:false in config).");
        }

        const result = await withFileMutationQueue(baselinePath, () =>
          runGate(cli, root, true, { cwd: root, timeoutMs: config.cliTimeoutMs, signal, env: sentruxChildEnv(config) }),
        );
        throwIfCliHalted("sentrux gate --save", result, config.cliTimeoutMs);
        const outcome = parseGateSaveOutput(result.stdout);

        if (outcome.kind !== "saved") {
          throw new Error(`sentrux gate --save failed: ${cliFailureDetail(result)}`);
        }

        let baseline: unknown;
        try {
          baseline = JSON.parse(await readFile(baselinePath, "utf8"));
        } catch (err) {
          throw new Error(`sentrux gate --save reported success but ${baselinePath} could not be read back: ${(err as Error).message}`);
        }

        const lines = ["sentrux gate: saved baseline to .sentrux/baseline.json", `quality ${outcome.quality}`];
        if (warning) lines.push(warning);

        const details: GateDetails = {
          root,
          binary: { path: binaryStatus.path, version: formatVersion(binaryStatus.version) },
          status: "saved",
          baselinePath,
          quality: { before: outcome.quality, after: outcome.quality },
          baseline,
        };
        const text = await buildModelText({
          toolCallId,
          text: lines.join("\n"),
          details,
          maxBytes: config.maxOutputBytes,
          maxLines: config.maxOutputLines,
        });
        return { content: [{ type: "text", text }], details };
      }

      const result = await runGate(cli, root, false, { cwd: root, timeoutMs: config.cliTimeoutMs, signal, env: sentruxChildEnv(config) });
      throwIfCliHalted("sentrux gate", result, config.cliTimeoutMs);
      const outcome = parseGateCompareOutput(result.stdout);

      if (outcome.kind === "ok") {
        return finishGateCompare("ok", outcome, root, binaryStatus, baselinePath, warning, config, toolCallId);
      }
      if (outcome.kind === "degraded") {
        return finishGateCompare("degraded", outcome, root, binaryStatus, baselinePath, warning, config, toolCallId);
      }
      if (result.stderr.includes("Failed to load baseline at")) {
        const lines = ["sentrux gate: no baseline found — call sentrux_gate save=true first"];
        if (warning) lines.push(warning);
        const details: GateDetails = {
          root,
          binary: { path: binaryStatus.path, version: formatVersion(binaryStatus.version) },
          status: "no_baseline",
          baselinePath,
        };
        const text = await buildModelText({
          toolCallId,
          text: lines.join("\n"),
          details,
          maxBytes: config.maxOutputBytes,
          maxLines: config.maxOutputLines,
        });
        return { content: [{ type: "text", text }], details };
      }
      throw new Error(`sentrux gate failed: ${cliFailureDetail(result)}`);
    },
  });
}

// --- sentrux_scan ---

const ScanParams = Type.Object({ path: PathParam }, { additionalProperties: false });

const UNTRACKED_SAMPLE_LIMIT = 20;

export interface SentruxScanDetails {
  root: string;
  scan: ScanResult;
  health: HealthResult;
  untracked: { count: number; sample: string[] };
  tier: "free" | "pro";
}

export function registerScanTool(pi: ExtensionAPI, deps: SentruxMcpToolDeps): void {
  pi.registerTool({
    name: "sentrux_scan",
    label: "Sentrux scan",
    description:
      "Measure the architectural quality of a directory with Sentrux (read-only). Returns the Quality Signal (0\u201310000, the geometric mean of modularity, acyclicity, depth, equality and redundancy), the bottleneck (the lowest root cause), each root cause's score and raw value, and size counts. Sentrux analyzes only git-tracked files. Improve quality by targeting the bottleneck.",
    promptSnippet: "Measure architecture quality (0\u201310000) and find the bottleneck root cause",
    promptGuidelines: [
      "Before a multi-file feature or refactor, call sentrux_session action=start; afterwards call action=end and fix any degradation you introduced.",
      "Sentrux sees only git-tracked files: new files are not measured until they are added to the git index.",
      "When asked to improve structure, work on the bottleneck root cause from sentrux_scan, re-measure after each change, and stop when gains plateau.",
    ],
    parameters: ScanParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      const config = deps.getConfig() ?? DEFAULT_CONFIG;
      const root = await resolveRoot(ctx.cwd, params.path);
      const callOpts = { signal, timeoutMs: config.mcpCallTimeoutMs };

      const client = await deps.registry.getClient(root);
      const scan = await client.callTool<ScanResult>("scan", { path: root }, callOpts);
      const health = await client.callTool<HealthResult>("health", {}, callOpts);

      let untrackedFiles: string[] = [];
      if (config.untrackedWarning) {
        untrackedFiles = (await findUntrackedFiles(root)).files;
      }
      const warning = formatUntrackedWarning(untrackedFiles);

      const lines = [formatScanHealth(root, scan, health)];
      if (warning) lines.push(warning);

      const details: SentruxScanDetails = {
        root,
        scan,
        health,
        untracked: { count: untrackedFiles.length, sample: untrackedFiles.slice(0, UNTRACKED_SAMPLE_LIMIT) },
        tier: health.upgrade ? "free" : "pro",
      };
      const text = await buildModelText({
        toolCallId,
        text: lines.join("\n"),
        details,
        maxBytes: config.maxOutputBytes,
        maxLines: config.maxOutputLines,
      });
      return { content: [{ type: "text", text }], details };
    },
  });
}

// --- sentrux_session ---

const SessionParams = Type.Object(
  {
    action: StringEnum(["start", "end", "status"], {
      description:
        "start: scan and record a baseline. end: rescan and report before/after (repeatable \u2014 always compares against the recorded start). status: report whether a baseline is currently recorded, without rescanning.",
    }),
    path: PathParam,
  },
  { additionalProperties: false },
);

export type SentruxSessionStatus = "started" | "pass" | "degraded" | "no_session" | "lost";

export interface SentruxSessionDetails {
  root: string;
  action: "start" | "end" | "status";
  status: SentruxSessionStatus;
  startedAt?: number;
  qualityAtStart?: number;
  sessionEnd?: SessionEndResult;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

const SESSION_LOST_TEXT = (root: string): string =>
  `session: lost \u2014 the Sentrux server restarted since the baseline was recorded; call sentrux_session action=start again.  (root ${root})`;
const SESSION_NO_SESSION_TEXT = (root: string): string =>
  `session: no_session \u2014 no baseline recorded for this root \u2014 call sentrux_session action=start first.  (root ${root})`;

export function registerSessionTool(pi: ExtensionAPI, deps: SentruxMcpToolDeps): void {
  pi.registerTool({
    name: "sentrux_session",
    label: "Sentrux session",
    description:
      "In-memory before/after measurement for this pi session. action=start scans and records a baseline; action=end rescans and reports signal before/after/delta, coupling and cycle changes, violations and pass/fail (can be repeated; always compares with the start); action=status reports whether a baseline exists. The baseline is lost if the Sentrux server restarts (timeout, abort, /sentrux restart).",
    promptSnippet: "Start/end an in-memory before/after quality session",
    parameters: SessionParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      const config = deps.getConfig() ?? DEFAULT_CONFIG;
      const root = await resolveRoot(ctx.cwd, params.path);
      const callOpts = { signal, timeoutMs: config.mcpCallTimeoutMs };
      const warning = await untrackedWarningLine(root, config);

      const finish = async (lines: string[], details: SentruxSessionDetails): Promise<AgentToolResult<SentruxSessionDetails>> => {
        if (warning) lines.push(warning);
        const text = await buildModelText({
          toolCallId,
          text: lines.join("\n"),
          details,
          maxBytes: config.maxOutputBytes,
          maxLines: config.maxOutputLines,
        });
        return { content: [{ type: "text", text }], details };
      };

      if (params.action === "start") {
        const client = await deps.registry.getClient(root);
        await client.callTool<ScanResult>("scan", { path: root }, callOpts);
        const sessionStart = await client.callTool<SessionStartResult>("session_start", {}, callOpts);
        const startedAt = Date.now();
        deps.registry.markSessionStarted(root, { startedAt, qualityAtStart: sessionStart.quality_signal });

        return finish([`session: started \u2014 quality ${sessionStart.quality_signal} recorded as baseline  (root ${root})`], {
          root,
          action: "start",
          status: "started",
          startedAt,
          qualityAtStart: sessionStart.quality_signal,
        });
      }

      if (params.action === "status") {
        const info = deps.registry.getHandleInfo(root);
        if (info?.hasSession && info.sessionBaseline) {
          const { startedAt, qualityAtStart } = info.sessionBaseline;
          return finish(
            [`session: active \u2014 baseline quality ${qualityAtStart} recorded ${formatElapsed(Date.now() - startedAt)} ago  (root ${root})`],
            { root, action: "status", status: "started", startedAt, qualityAtStart },
          );
        }
        if (info?.lostSession) {
          return finish([SESSION_LOST_TEXT(root)], { root, action: "status", status: "lost" });
        }
        return finish([SESSION_NO_SESSION_TEXT(root)], { root, action: "status", status: "no_session" });
      }

      // action === "end"
      const preInfo = deps.registry.getHandleInfo(root);
      if (!preInfo) {
        // Never touched via the registry at all: no session could possibly have started for this
        // root, so there is no need to spawn an MCP server just to report that.
        return finish([SESSION_NO_SESSION_TEXT(root)], { root, action: "end", status: "no_session" });
      }

      const client = await deps.registry.getClient(root); // refreshes generation/lostSession bookkeeping
      const info = deps.registry.getHandleInfo(root);
      if (!info?.hasSession) {
        return info?.lostSession
          ? finish([SESSION_LOST_TEXT(root)], { root, action: "end", status: "lost" })
          : finish([SESSION_NO_SESSION_TEXT(root)], { root, action: "end", status: "no_session" });
      }

      const sessionEnd = await client.callTool<SessionEndResult>("session_end", {}, callOpts);
      const status: SentruxSessionStatus = sessionEnd.pass ? "pass" : "degraded";
      return finish([formatSessionEnd(sessionEnd)], { root, action: "end", status, sessionEnd });
    },
  });
}

// --- sentrux_insights ---

const InsightsParams = Type.Object(
  {
    kind: StringEnum(["dsm", "test_gaps", "git_stats"], {
      description:
        "dsm: dependency-structure-matrix statistics. test_gaps: source files without tests and the coverage ratio. git_stats: churn, hotspots, coupling pairs and bus factor from recent git history.",
    }),
    path: PathParam,
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "test_gaps only: top-N riskiest untested files." }),
    ),
    days: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 3650, description: "git_stats only: lookback window in days. Default: 90." }),
    ),
    format: Type.Optional(
      StringEnum(["stats", "text"], {
        description: "dsm only: 'text' adds the ASCII matrix on Pro; identical to 'stats' in the free tier.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface SentruxInsightsDetails {
  root: string;
  kind: "dsm" | "test_gaps" | "git_stats";
  result: DsmResult | TestGapsResult | GitStatsResult;
}

export function registerInsightsTool(pi: ExtensionAPI, deps: SentruxMcpToolDeps): void {
  pi.registerTool({
    name: "sentrux_insights",
    label: "Sentrux insights",
    description:
      "Extra Sentrux architecture views (read-only): kind=dsm \u2014 dependency-structure-matrix statistics (density, propagation cost, level breaks; format=text adds the matrix on Pro); kind=test_gaps \u2014 source files without tests and the coverage ratio (limit 1\u2013100); kind=git_stats \u2014 churn, hotspots, coupling pairs and bus factor from the last `days` of git history. The free tier returns summary counts only.",
    promptSnippet: "DSM, test-gap and git-churn architecture views",
    parameters: InsightsParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      const config = deps.getConfig() ?? DEFAULT_CONFIG;
      const root = await resolveRoot(ctx.cwd, params.path);
      const callOpts = { signal, timeoutMs: config.mcpCallTimeoutMs };
      const warning = await untrackedWarningLine(root, config);

      const client = await deps.registry.getClient(root);
      await client.callTool<ScanResult>("scan", { path: root }, callOpts);

      let text: string;
      let result: DsmResult | TestGapsResult | GitStatsResult;
      if (params.kind === "dsm") {
        const args: Record<string, unknown> = {};
        if (params.format !== undefined) args.format = params.format;
        const dsm = await client.callTool<DsmResult>("dsm", args, callOpts);
        text = formatDsm(dsm);
        result = dsm;
      } else if (params.kind === "test_gaps") {
        const args: Record<string, unknown> = {};
        if (params.limit !== undefined) args.limit = params.limit;
        const testGaps = await client.callTool<TestGapsResult>("test_gaps", args, callOpts);
        text = formatTestGaps(testGaps);
        result = testGaps;
      } else {
        const args: Record<string, unknown> = {};
        if (params.days !== undefined) args.days = params.days;
        const gitStats = await client.callTool<GitStatsResult>("git_stats", args, callOpts);
        text = formatGitStats(gitStats);
        result = gitStats;
      }

      const lines = [text];
      if (warning) lines.push(warning);

      // SAFETY: TypeBox's Static<> widens a StringEnum-typed object property to `string`
      // (typebox 1.3.27); the tool's runtime schema validation already restricts params.kind
      // to one of the three branches handled above.
      const details: SentruxInsightsDetails = { root, kind: params.kind as "dsm" | "test_gaps" | "git_stats", result };
      const modelText = await buildModelText({
        toolCallId,
        text: lines.join("\n"),
        details,
        maxBytes: config.maxOutputBytes,
        maxLines: config.maxOutputLines,
      });
      return { content: [{ type: "text", text: modelText }], details };
    },
  });
}
