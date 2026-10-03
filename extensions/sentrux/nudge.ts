import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SentruxConfig } from "./config.ts";
import type { HealthResult, ScanResult } from "./format.ts";
import type { McpServerRegistry } from "./servers.ts";

export interface NudgeDeps {
  getConfig: () => SentruxConfig | undefined;
  registry: McpServerRegistry;
}

/** Minimal quality snapshot used for baseline/compare. Cycles come from
 * `health.root_causes.acyclicity.raw` (the cycle count, verified P0); `scores`
 * keeps every root-cause score so the nudge can name the cause that dropped most. */
export interface NudgeMeasurement {
  quality: number;
  cycles: number;
  bottleneck: string;
  scores: Record<string, number>;
}

export interface NudgeDetails {
  root: string;
  before: NudgeMeasurement;
  after: NudgeMeasurement;
  delta: number;
  threshold: number;
  reason: "drop" | "cycles";
}

const BASELINE_AWAIT_TIMEOUT_MS = 30_000;

function isNudgeEnabled(deps: NudgeDeps): boolean {
  return (deps.getConfig()?.nudge ?? "off") === "agent_end";
}

function nudgeThreshold(deps: NudgeDeps): number {
  return deps.getConfig()?.nudgeThreshold ?? 200;
}

function callTimeoutMs(deps: NudgeDeps): number | undefined {
  return deps.getConfig()?.mcpCallTimeoutMs;
}

/** Build a measurement from a scan+health pair. Health wins for quality when present. */
export function toMeasurement(scan: ScanResult, health: HealthResult): NudgeMeasurement {
  const rawCycles = health.root_causes?.acyclicity?.raw;
  const scores: Record<string, number> = {};
  for (const [name, rc] of Object.entries(health.root_causes ?? {})) {
    if (typeof rc?.score === "number") scores[name] = rc.score;
  }
  return {
    quality: health.quality_signal ?? scan.quality_signal,
    cycles: typeof rawCycles === "number" ? rawCycles : 0,
    bottleneck: health.bottleneck ?? "unknown",
    scores,
  };
}

/** True when the after-state is worth nudging about: quality dropped by at
 * least `threshold` points, or the cycle count rose. */
export function shouldNudge(before: NudgeMeasurement, after: NudgeMeasurement, threshold: number): NudgeDetails | undefined {
  const delta = after.quality - before.quality;
  const drop = before.quality - after.quality;
  if (drop >= threshold) {
    return { root: "", before, after, delta, threshold, reason: "drop" };
  }
  if (after.cycles > before.cycles) {
    return { root: "", before, after, delta, threshold, reason: "cycles" };
  }
  return undefined;
}

/** The root cause whose score fell the most between two measurements (undefined
 * when nothing fell). Names the regression's location instead of the overall
 * bottleneck, which may be an unrelated chronically-low cause. */
export function worstRootCauseDrop(
  before: NudgeMeasurement,
  after: NudgeMeasurement,
): { name: string; delta: number } | undefined {
  let worst: { name: string; delta: number } | undefined;
  const names = new Set([...Object.keys(before.scores ?? {}), ...Object.keys(after.scores ?? {})]);
  for (const name of names) {
    const b = before.scores?.[name];
    const a = after.scores?.[name];
    if (typeof b !== "number" || typeof a !== "number") continue;
    const delta = a - b;
    if (!worst || delta < worst.delta) worst = { name, delta };
  }
  return worst && worst.delta < 0 ? worst : undefined;
}

export function formatNudgeMessage(before: NudgeMeasurement, after: NudgeMeasurement): string {
  const delta = after.quality - before.quality;
  const signed = delta > 0 ? `+${delta}` : `${delta}`;
  const worst = worstRootCauseDrop(before, after);
  const cause = worst ? `worst drop: ${worst.name} (${worst.delta})` : `bottleneck ${after.bottleneck}`;
  return `sentrux: quality ${before.quality} → ${after.quality} (${signed}), cycles ${before.cycles} → ${after.cycles}; ${cause}. Consider fixing before continuing.`;
}

export function formatNudgeStatus(after: NudgeMeasurement, delta: number): string {
  const signed = delta > 0 ? `+${delta}` : `${delta}`;
  return `Q ${after.quality} (${signed})`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Resolves once `signal` aborts (or immediately when already aborted). Lets a wait bail
 * out on ESC instead of spinning until its timeout while the user asked to stop. */
function onSignalAbort(signal: AbortSignal | undefined): Promise<undefined> {
  if (!signal) return new Promise<undefined>(() => undefined); // never resolves: no signal to wait on
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

/** Key roots by realpath: the tools resolve `path` to its real path before touching
 * the registry, so the nudge must use the same key or it tracks a different entry.
 * Synchronous so the `tool_result` hook records dirtiness deterministically. */
function nudgeKey(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** Per-registration state shared by the four nudge hooks. */
interface NudgeRunState {
  cache: Map<string, NudgeMeasurement>;
  inFlight: Map<string, Promise<NudgeMeasurement | undefined>>;
  /** Agent-run epoch: `before_agent_start` bumps it and drops pending baselines, so a
   * new run never reuses the previous run's pending baseline promise — and a stale
   * baseline that settles late cannot overwrite the new run's cache entry. */
  runEpoch: number;
  dirty: Set<string>;
  /** Roots whose baseline wait already ran this agent run: the pre-edit wait costs
   * at most one wait per root per run, not 30 s on every later edit. Reset on
   * before_agent_start alongside `dirty`/`nudgedInRun`. */
  waited: Set<string>;
  nudgedInRun: boolean;
}

/** A nudge rescan shares the per-root MCP server with sentrux_session; on a call
 * timeout the server is killed and the session baseline is lost. Skip nudge scans
 * while a session baseline is active for that root instead of destroying it. */
function hasActiveSession(deps: NudgeDeps, root: string): boolean {
  try {
    return deps.registry.getHandleInfo(root)?.hasSession ?? false;
  } catch {
    return false;
  }
}

async function measureRoot(deps: NudgeDeps, root: string): Promise<NudgeMeasurement | undefined> {
  if (hasActiveSession(deps, root)) return undefined;
  try {
    const client = await deps.registry.getClient(root);
    const opts = { timeoutMs: callTimeoutMs(deps) };
    const scan = await client.callTool<ScanResult>("scan", { path: root }, opts);
    const health = await client.callTool<HealthResult>("health", {}, opts);
    return toMeasurement(scan, health);
  } catch {
    return undefined;
  }
}

async function baselineScan(
  state: NudgeRunState,
  deps: NudgeDeps,
  root: string,
  epoch: number,
): Promise<NudgeMeasurement | undefined> {
  try {
    const m = await measureRoot(deps, root);
    // A previous run's baseline settling after the run boundary must not
    // overwrite the new run's cache entry.
    if (m && epoch === state.runEpoch) state.cache.set(root, m);
    return m;
  } catch {
    return undefined;
  }
}

function startBaseline(state: NudgeRunState, deps: NudgeDeps, root: string): void {
  if (state.cache.has(root) || state.inFlight.has(root)) return;
  const p = baselineScan(state, deps, root, state.runEpoch);
  state.inFlight.set(root, p);
  // Deliberately not awaited: warm-up style; tool_call awaits it when needed.
  // The guard keeps a late-settling promise from evicting a newer run's entry.
  void p.catch(() => undefined).finally(() => {
    if (state.inFlight.get(root) === p) state.inFlight.delete(root);
  });
}

function isEditTool(toolName: string): boolean {
  return toolName === "edit" || toolName === "write";
}

function awaitBaseline(
  pending: Promise<NudgeMeasurement | undefined>,
  signal: AbortSignal | undefined,
): Promise<NudgeMeasurement | undefined> {
  return Promise.race([withTimeout(pending, BASELINE_AWAIT_TIMEOUT_MS), onSignalAbort(signal)]);
}

function onBeforeAgentStart(state: NudgeRunState, deps: NudgeDeps, ctx: ExtensionContext): void {
  state.nudgedInRun = false;
  state.dirty.clear();
  state.waited.clear();
  // Fresh baseline every run: the cache would otherwise blame the agent for edits
  // the user made between runs. The epoch bump also retires the previous run's
  // pending baseline (a new one starts below) and blocks its late cache write.
  state.runEpoch += 1;
  state.cache.clear();
  state.inFlight.clear();
  if (!isNudgeEnabled(deps)) return;
  try {
    const root = nudgeKey(ctx.cwd);
    if (!state.cache.has(root) && !state.inFlight.has(root)) {
      startBaseline(state, deps, root);
    }
  } catch {
    // Hooks never throw.
  }
}

async function onToolCall(
  state: NudgeRunState,
  deps: NudgeDeps,
  event: { toolName: string },
  ctx: ExtensionContext,
): Promise<void> {
  if (!isNudgeEnabled(deps)) return;
  if (!isEditTool(event.toolName)) return;
  let root: string;
  try {
    root = nudgeKey(ctx.cwd);
  } catch {
    // Hooks never throw.
    return;
  }
  // At most one pre-edit wait per root per run; later edits reuse the baseline.
  if (state.waited.has(root)) return;
  state.waited.add(root);
  const pending = state.inFlight.get(root);
  if (!pending) return;
  try {
    // Awaited before the edit runs: guarantees a pre-edit baseline. Races the
    // host abort signal so ESC interrupts the wait instead of spinning 30 s.
    await awaitBaseline(pending, ctx.signal);
  } catch {
    // Hooks never throw.
  }
}

function onToolResult(
  state: NudgeRunState,
  deps: NudgeDeps,
  event: { toolName: string; isError?: boolean },
  ctx: ExtensionContext,
): void {
  if (!isNudgeEnabled(deps)) return;
  if (!isEditTool(event.toolName)) return;
  if (event.isError) return;
  try {
    state.dirty.add(nudgeKey(ctx.cwd));
  } catch {
    // Hooks never throw.
  }
}

function onAgentEnd(pi: ExtensionAPI, state: NudgeRunState, deps: NudgeDeps, ctx: ExtensionContext): void {
  if (!isNudgeEnabled(deps)) return;
  if (state.nudgedInRun) return;
  void rescanAndNudge(pi, state, deps, ctx).catch(() => undefined);
}

async function rescanAndNudge(
  pi: ExtensionAPI,
  state: NudgeRunState,
  deps: NudgeDeps,
  ctx: ExtensionContext,
): Promise<void> {
  let root: string;
  try {
    root = nudgeKey(ctx.cwd);
  } catch {
    // Hooks never throw.
    return;
  }
  if (!state.dirty.has(root)) return;
  state.dirty.delete(root);
  if (hasActiveSession(deps, root)) return;
  // The rescan + nudge run in the background: agent_end delays idle, and this
  // outer void already makes the whole block fire-and-forget.
  const before = await resolveBaselineBefore(state, root, ctx);
  let after: NudgeMeasurement | undefined;
  try {
    after = await measureRoot(deps, root);
  } catch {
    after = undefined;
  }
  if (!after) return;
  if (!before) {
    state.cache.set(root, after);
    return;
  }
  state.cache.set(root, after);
  const threshold = nudgeThreshold(deps);
  const decision = shouldNudge(before, after, threshold);
  if (!decision) return;
  if (state.nudgedInRun) return;
  state.nudgedInRun = true;
  const content = formatNudgeMessage(before, after);
  const details: NudgeDetails = {
    root,
    before,
    after,
    delta: after.quality - before.quality,
    threshold,
    reason: decision.reason,
  };
  deliverNudge(pi, ctx, details, content, after, after.quality - before.quality);
}

async function resolveBaselineBefore(
  state: NudgeRunState,
  root: string,
  ctx: ExtensionContext,
): Promise<NudgeMeasurement | undefined> {
  const cached = state.cache.get(root);
  if (cached) return cached;
  const pending = state.inFlight.get(root);
  if (!pending) return undefined;
  try {
    return (await awaitBaseline(pending, ctx.signal)) ?? undefined;
  } catch {
    return undefined;
  }
}

function deliverNudge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  details: NudgeDetails,
  content: string,
  after: NudgeMeasurement,
  delta: number,
): void {
  try {
    pi.sendMessage({ customType: "sentrux-nudge", content, display: true, details }, { deliverAs: "nextTurn" });
  } catch {
    // sendMessage on a torn-down session throws; nothing to do.
  }
  try {
    (ctx as ExtensionContext).ui.setStatus("sentrux", formatNudgeStatus(after, delta));
  } catch {
    // Stale ctx after shutdown; safe to ignore like the warm-up path.
  }
}

/**
 * Opt-in post-edit nudge (§6.6). Off by default; enabled with `nudge:"agent_end"`.
 *
 * All Sentrux access goes through the shared per-root registry — this module
 * never spawns a process or invokes the CLI itself. The `agent_end` follow-up
 * is always fire-and-forget (`void ...`) so pi reaches idle without waiting
 * for the rescan. At most one nudge is sent per agent run
 * (`before_agent_start` → `agent_end`).
 */
export function registerNudgeHooks(pi: ExtensionAPI, deps: NudgeDeps): void {
  const state: NudgeRunState = {
    cache: new Map(),
    inFlight: new Map(),
    runEpoch: 0,
    dirty: new Set(),
    waited: new Set(),
    nudgedInRun: false,
  };
  pi.on("before_agent_start", (_event, ctx) => onBeforeAgentStart(state, deps, ctx));
  pi.on("tool_call", (event, ctx) => onToolCall(state, deps, event, ctx));
  pi.on("tool_result", (event, ctx) => onToolResult(state, deps, event, ctx));
  pi.on("agent_end", (_event, ctx) => onAgentEnd(pi, state, deps, ctx));
}
