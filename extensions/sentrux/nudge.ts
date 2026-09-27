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
 * `health.root_causes.acyclicity.raw` (the cycle count, verified P0). */
export interface NudgeMeasurement {
  quality: number;
  cycles: number;
  bottleneck: string;
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
  return {
    quality: health.quality_signal ?? scan.quality_signal,
    cycles: typeof rawCycles === "number" ? rawCycles : 0,
    bottleneck: health.bottleneck ?? "unknown",
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

export function formatNudgeMessage(before: NudgeMeasurement, after: NudgeMeasurement): string {
  const delta = after.quality - before.quality;
  const signed = delta > 0 ? `+${delta}` : `${delta}`;
  return (
    `sentrux: quality ${before.quality} → ${after.quality} (${signed}), ` +
    `cycles ${before.cycles} → ${after.cycles}; bottleneck ${after.bottleneck}. ` +
    `Consider fixing before continuing.`
  );
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
  const cache = new Map<string, NudgeMeasurement>();
  const inFlight = new Map<string, Promise<NudgeMeasurement | undefined>>();
  const dirty = new Set<string>();
  /** Roots whose baseline wait already ran this agent run: the pre-edit wait costs
   * at most one wait per root per run, not 30 s on every later edit. Reset on
   * before_agent_start alongside `dirty`/`nudgedInRun`. */
  const waited = new Set<string>();
  let nudgedInRun = false;

  /** A nudge rescan shares the per-root MCP server with sentrux_session; on a call
   * timeout the server is killed and the session baseline is lost. Skip nudge scans
   * while a session baseline is active for that root instead of destroying it. */
  function hasActiveSession(root: string): boolean {
    try {
      return deps.registry.getHandleInfo(root)?.hasSession ?? false;
    } catch {
      return false;
    }
  }

  async function measure(root: string): Promise<NudgeMeasurement | undefined> {
    if (hasActiveSession(root)) return undefined;
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

  async function baselineScan(root: string): Promise<NudgeMeasurement | undefined> {
    try {
      const m = await measure(root);
      if (m) cache.set(root, m);
      return m;
    } catch {
      return undefined;
    } finally {
      inFlight.delete(root);
    }
  }

  function startBaseline(root: string): void {
    if (cache.has(root) || inFlight.has(root)) return;
    const p = baselineScan(root);
    inFlight.set(root, p);
    // Deliberately not awaited: warm-up style; tool_call awaits it when needed.
    void p.catch(() => undefined);
  }

  pi.on("before_agent_start", (_event, ctx) => {
    nudgedInRun = false;
    dirty.clear();
    waited.clear();
    // Fresh baseline every run: the cache would otherwise blame the agent for edits
    // the user made between runs.
    cache.clear();
    if (!isNudgeEnabled(deps)) return;
    try {
      const root = nudgeKey(ctx.cwd);
      if (!cache.has(root) && !inFlight.has(root)) {
        startBaseline(root);
      }
    } catch {
      // Hooks never throw.
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isNudgeEnabled(deps)) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    let root: string;
    try {
      root = nudgeKey(ctx.cwd);
    } catch {
      // Hooks never throw.
      return;
    }
    // At most one pre-edit wait per root per run; later edits reuse the baseline.
    if (waited.has(root)) return;
    waited.add(root);
    const pending = inFlight.get(root);
    if (!pending) return;
    try {
      // Awaited before the edit runs: guarantees a pre-edit baseline. Races the
      // host abort signal so ESC interrupts the wait instead of spinning 30 s.
      await Promise.race([withTimeout(pending, BASELINE_AWAIT_TIMEOUT_MS), onSignalAbort(ctx.signal)]);
    } catch {
      // Hooks never throw.
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (!isNudgeEnabled(deps)) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (event.isError) return;
    try {
      dirty.add(nudgeKey(ctx.cwd));
    } catch {
      // Hooks never throw.
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!isNudgeEnabled(deps)) return;
    if (nudgedInRun) return;
    void (async () => {
      let root: string;
      try {
        root = nudgeKey(ctx.cwd);
      } catch {
        // Hooks never throw.
        return;
      }
      if (!dirty.has(root)) return;
      dirty.delete(root);
      if (hasActiveSession(root)) return;
      // The rescan + nudge run in the background: agent_end delays idle, and this
      // outer void already makes the whole block fire-and-forget.
      let before = cache.get(root);
      if (!before) {
        const pending = inFlight.get(root);
        if (pending) {
          try {
            before = (await Promise.race([withTimeout(pending, BASELINE_AWAIT_TIMEOUT_MS), onSignalAbort(ctx.signal)])) ?? undefined;
          } catch {
            before = undefined;
          }
        }
      }
      let after: NudgeMeasurement | undefined;
      try {
        after = await measure(root);
      } catch {
        after = undefined;
      }
      if (!after) return;
      if (!before) {
        cache.set(root, after);
        return;
      }
      cache.set(root, after);
      const threshold = nudgeThreshold(deps);
      const decision = shouldNudge(before, after, threshold);
      if (!decision) return;
      if (nudgedInRun) return;
      nudgedInRun = true;
      const content = formatNudgeMessage(before, after);
      const details: NudgeDetails = { root, before, after, delta: after.quality - before.quality, threshold, reason: decision.reason };
      try {
        pi.sendMessage({ customType: "sentrux-nudge", content, display: true, details }, { deliverAs: "nextTurn" });
      } catch {
        // sendMessage on a torn-down session throws; nothing to do.
      }
      try {
        (ctx as ExtensionContext).ui.setStatus("sentrux", formatNudgeStatus(after, after.quality - before.quality));
      } catch {
        // Stale ctx after shutdown; safe to ignore like the warm-up path.
      }
    })().catch(() => undefined);
  });
}
