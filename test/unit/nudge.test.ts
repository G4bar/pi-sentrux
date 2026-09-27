import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type SentruxConfig } from "../../extensions/sentrux/config.ts";
import type { HealthResult, ScanResult } from "../../extensions/sentrux/format.ts";
import {
  formatNudgeMessage,
  formatNudgeStatus,
  registerNudgeHooks,
  shouldNudge,
  toMeasurement,
} from "../../extensions/sentrux/nudge.ts";

function makeHealth(overrides: Partial<HealthResult> = {}): HealthResult {
  return {
    bottleneck: "equality",
    cross_module_edges: 0,
    quality_signal: 7000,
    root_causes: {
      modularity: { raw: 0.1, score: 4000 },
      acyclicity: { raw: 0, score: 10000 },
      depth: { raw: 1, score: 8889 },
      equality: { raw: 0.5, score: 5000 },
      redundancy: { raw: 0.2, score: 8000 },
    },
    total_import_edges: 10,
    ...overrides,
  };
}

function makeScan(quality = 7000): ScanResult {
  return { files: 10, import_edges: 5, lines: 100, quality_signal: quality, scanned: "/root" };
}

function makeCtx(cwd: string, signal?: AbortSignal) {
  return { cwd, signal, ui: { setStatus: vi.fn(), notify: vi.fn() } } as any;
}

function makeConfig(overrides: Partial<SentruxConfig> = {}): SentruxConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

interface CapturedPi {
  pi: any;
  handlers: Map<string, ((event: any, ctx: any) => any)[]>;
  sentMessages: { message: any; options: any }[];
}

function makePi(): CapturedPi {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const sentMessages: { message: any; options: any }[] = [];
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    sendMessage: (message: any, options: any) => {
      sentMessages.push({ message, options });
    },
  } as any;
  return { pi, handlers, sentMessages };
}

function emit(handlers: CapturedPi["handlers"], event: string, payload: any, ctx: any): Promise<unknown[]> {
  const list = handlers.get(event) ?? [];
  return Promise.all(list.map((h) => h(payload, ctx)));
}

function makeRegistry(sequence: { scan: ScanResult; health: HealthResult }[], tracker?: { getClientCalls: number; toolCalls: string[] }) {
  let index = 0;
  const calls: string[] = tracker?.toolCalls ?? [];
  return {
    getClientCalls: 0,
    async getClient(_root: string) {
      this.getClientCalls++;
      if (tracker) tracker.getClientCalls++;
      const step = sequence[Math.min(index, sequence.length - 1)];
      return {
        generation: 0,
        pid: 1234,
        isAlive: true,
        start: async () => undefined,
        close: async () => undefined,
        forceKillSync: () => undefined,
        callTool: async <T>(name: string): Promise<T> => {
          calls.push(name);
          if (name === "scan") return step.scan as unknown as T;
          if (name === "health") return step.health as unknown as T;
          throw new Error(`unexpected tool ${name}`);
        },
      } as any;
    },
    __advance() {
      index++;
    },
  } as any;
}

async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("toMeasurement / shouldNudge / format", () => {
  it("takes quality from health and cycles from acyclicity.raw", () => {
    const m = toMeasurement(makeScan(1111), makeHealth({ quality_signal: 7222, bottleneck: "depth" }));
    expect(m).toEqual({ quality: 7222, cycles: 0, bottleneck: "depth" });
  });

  it("reads a nonzero cycle count from acyclicity.raw", () => {
    const health = makeHealth();
    health.root_causes.acyclicity = { raw: 2, score: 3333 };
    expect(toMeasurement(makeScan(), health).cycles).toBe(2);
  });

  it("nudges on a drop at or above the threshold", () => {
    const before = { quality: 7342, cycles: 0, bottleneck: "equality" };
    const after = { quality: 7142, cycles: 0, bottleneck: "equality" };
    expect(shouldNudge(before, after, 200)?.reason).toBe("drop");
    expect(shouldNudge({ ...before }, { ...after, quality: 7143 }, 200)).toBeUndefined();
  });

  it("nudges when cycles rise even without a quality drop", () => {
    const before = { quality: 7000, cycles: 0, bottleneck: "equality" };
    const after = { quality: 6999, cycles: 1, bottleneck: "acyclicity" };
    expect(shouldNudge(before, after, 200)?.reason).toBe("cycles");
  });

  it("formats the nudge message and status line", () => {
    const before = { quality: 7342, cycles: 0, bottleneck: "equality" };
    const after = { quality: 7010, cycles: 1, bottleneck: "equality" };
    expect(formatNudgeMessage(before, after)).toBe(
      "sentrux: quality 7342 → 7010 (-332), cycles 0 → 1; bottleneck equality. Consider fixing before continuing.",
    );
    expect(formatNudgeStatus(after, -332)).toBe("Q 7010 (-332)");
  });
});

describe("registerNudgeHooks", () => {
  it("with nudge off, no hook touches the registry or sends messages", async () => {
    const captured = makePi();
    const tracker = { getClientCalls: 0, toolCalls: [] as string[] };
    const registry = makeRegistry([{ scan: makeScan(), health: makeHealth() }], tracker);
    const config = makeConfig({ nudge: "off" });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await emit(captured.handlers, "tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit" }, ctx);
    await emit(captured.handlers, "tool_result", { type: "tool_result", toolCallId: "1", toolName: "edit", isError: false }, ctx);
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush();

    expect(tracker.getClientCalls).toBe(0);
    expect(tracker.toolCalls).toEqual([]);
    expect(captured.sentMessages).toEqual([]);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("with nudge on, an edit followed by a quality drop produces a next-turn nudge", async () => {
    const captured = makePi();
    // Baseline first, degraded second. The registry fake serves sequence[0] until advanced.
    const steps = [
      { scan: makeScan(7342), health: makeHealth({ quality_signal: 7342, bottleneck: "equality" }) },
      { scan: makeScan(7010), health: makeHealth({ quality_signal: 7010, bottleneck: "equality" }) },
    ];
    let stepIndex = 0;
    const toolCalls: string[] = [];
    const registry = {
      getClientCalls: 0,
      async getClient() {
        this.getClientCalls++;
        const step = steps[stepIndex];
        return {
          generation: 0,
          pid: 4242,
          isAlive: true,
          start: async () => undefined,
          close: async () => undefined,
          forceKillSync: () => undefined,
          callTool: async <T>(name: string): Promise<T> => {
            toolCalls.push(name);
            if (name === "scan") return step.scan as unknown as T;
            if (name === "health") return step.health as unknown as T;
            throw new Error(`unexpected tool ${name}`);
          },
        } as any;
      },
    } as any;
    const config = makeConfig({ nudge: "agent_end", nudgeThreshold: 200 });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await flush();
    expect(registry.getClientCalls).toBe(1);

    // Move to the degraded measurement before the agent_end rescan.
    stepIndex = 1;
    await emit(captured.handlers, "tool_call", { type: "tool_call", toolCallId: "e1", toolName: "edit" }, ctx);
    await emit(captured.handlers, "tool_result", { type: "tool_result", toolCallId: "e1", toolName: "edit", isError: false }, ctx);
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush(50);

    expect(captured.sentMessages).toHaveLength(1);
    expect(captured.sentMessages[0].options).toEqual({ deliverAs: "nextTurn" });
    expect(captured.sentMessages[0].message.customType).toBe("sentrux-nudge");
    expect(captured.sentMessages[0].message.display).toBe(true);
    expect(captured.sentMessages[0].message.content).toContain("7342 → 7010 (-332)");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("sentrux", "Q 7010 (-332)");
    // The nudge never touches session tools.
    expect(toolCalls).not.toContain("session_start");
    expect(toolCalls).not.toContain("session_end");
  });

  it("does not nudge when quality is stable and cycles do not rise", async () => {
    const captured = makePi();
    const steady = { scan: makeScan(7000), health: makeHealth({ quality_signal: 7000 }) };
    const registry = makeRegistry([steady, steady]);
    const config = makeConfig({ nudge: "agent_end", nudgeThreshold: 200 });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await flush();
    await emit(captured.handlers, "tool_call", { type: "tool_call", toolCallId: "e1", toolName: "edit" }, ctx);
    await emit(captured.handlers, "tool_result", { type: "tool_result", toolCallId: "e1", toolName: "edit", isError: false }, ctx);
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush(50);

    expect(captured.sentMessages).toEqual([]);
  });

  it("fires at most once per run even across repeated dirty agent_end events", async () => {
    const captured = makePi();
    const degraded = { scan: makeScan(6000), health: makeHealth({ quality_signal: 6000 }) };
    const registry = makeRegistry([{ scan: makeScan(7342), health: makeHealth({ quality_signal: 7342 }) }, degraded, degraded]);
    // Advance past the baseline immediately: every measure reads the degraded step.
    const config = makeConfig({ nudge: "agent_end", nudgeThreshold: 200 });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await flush();
    (registry as any).__advance();
    (registry as any).__advance();

    await emit(captured.handlers, "tool_result", { type: "tool_result", toolCallId: "e1", toolName: "write", isError: false }, ctx);
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush(50);
    expect(captured.sentMessages).toHaveLength(1);

    // A second dirty agent_end in the same run must not send again.
    await emit(captured.handlers, "tool_result", { type: "tool_result", toolCallId: "e2", toolName: "write", isError: false }, ctx);
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush(50);
    expect(captured.sentMessages).toHaveLength(1);
  });

  it("agent_end without any edit does no work", async () => {
    const captured = makePi();
    const tracker = { getClientCalls: 0, toolCalls: [] as string[] };
    const registry = makeRegistry([{ scan: makeScan(), health: makeHealth() }], tracker);
    const config = makeConfig({ nudge: "agent_end" });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await flush();
    const callsAfterBaseline = tracker.getClientCalls;
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush();
    expect(tracker.getClientCalls).toBe(callsAfterBaseline);
    expect(captured.sentMessages).toEqual([]);
  });

  it("ignores non-edit/write tools and error results", async () => {
    const captured = makePi();
    const steady = { scan: makeScan(7000), health: makeHealth({ quality_signal: 7000 }) };
    const registry = makeRegistry([steady, steady]);
    const config = makeConfig({ nudge: "agent_end" });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await flush();
    await emit(captured.handlers, "tool_call", { type: "tool_call", toolCallId: "b1", toolName: "bash" }, ctx);
    await emit(
      captured.handlers,
      "tool_result",
      { type: "tool_result", toolCallId: "b1", toolName: "bash", isError: false },
      ctx,
    );
    await emit(
      captured.handlers,
      "tool_result",
      { type: "tool_result", toolCallId: "e9", toolName: "edit", isError: true },
      ctx,
    );
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush();
    expect(captured.sentMessages).toEqual([]);
  });

  it("agent_end returns immediately without waiting for the rescan (idle is not blocked)", async () => {
    const captured = makePi();
    let releaseRescan!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRescan = resolve;
    });
    const registry = {
      getClientCalls: 0,
      async getClient() {
        this.getClientCalls++;
        return {
          generation: 0,
          pid: 1,
          isAlive: true,
          start: async () => undefined,
          close: async () => undefined,
          forceKillSync: () => undefined,
          callTool: async <T>(name: string): Promise<T> => {
            if (this.getClientCalls === 1) {
              if (name === "scan") return makeScan(7000) as unknown as T;
              return makeHealth({ quality_signal: 7000 }) as unknown as T;
            }
            await gate;
            if (name === "scan") return makeScan(6000) as unknown as T;
            return makeHealth({ quality_signal: 6000 }) as unknown as T;
          },
        } as any;
      },
    } as any;
    const config = makeConfig({ nudge: "agent_end", nudgeThreshold: 200 });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await flush();
    await emit(captured.handlers, "tool_result", { type: "tool_result", toolCallId: "e1", toolName: "edit", isError: false }, ctx);
    const start = Date.now();
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    const elapsed = Date.now() - start;
    // The handler itself must not await the hanging rescan.
    expect(elapsed).toBeLessThan(1000);
    releaseRescan();
    await flush(50);
    expect(captured.sentMessages).toHaveLength(1);
  });

  it("the pre-edit baseline wait respects ctx.signal and happens once per root per run", async () => {
    const captured = makePi();
    // The baseline never settles: without signal support every edit would wait 30 s.
    const registry = {
      getClientCalls: 0,
      async getClient() {
        this.getClientCalls++;
        await new Promise<void>(() => undefined);
      },
    } as any;
    const config = makeConfig({ nudge: "agent_end" });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, makeCtx("/root"));
    await flush();
    expect(registry.getClientCalls).toBe(1);

    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await emit(
      captured.handlers,
      "tool_call",
      { type: "tool_call", toolCallId: "e1", toolName: "edit" },
      makeCtx("/root", controller.signal),
    );
    // ESC interrupts the wait instead of spinning the 30 s baseline timeout.
    expect(Date.now() - start).toBeLessThan(5000);

    // A second edit in the same run does not wait again: no new baseline work starts.
    await emit(
      captured.handlers,
      "tool_call",
      { type: "tool_call", toolCallId: "e2", toolName: "edit" },
      makeCtx("/root", controller.signal),
    );
    expect(registry.getClientCalls).toBe(1);
  });

  it("skips nudge scans while a session baseline is active for the root", async () => {
    const captured = makePi();
    const degraded = { scan: makeScan(6000), health: makeHealth({ quality_signal: 6000 }) };
    const registry = {
      getClientCalls: 0,
      getHandleInfo: () => ({
        generation: 0,
        hasSession: true,
        lostSession: false,
        lastUsed: Date.now(),
        pid: 4242,
        sessionBaseline: { startedAt: Date.now(), qualityAtStart: 7342 },
        alive: true,
      }),
      async getClient() {
        this.getClientCalls++;
        return {
          generation: 0,
          pid: 4242,
          isAlive: true,
          start: async () => undefined,
          close: async () => undefined,
          forceKillSync: () => undefined,
          callTool: async <T>(name: string): Promise<T> => {
            if (name === "scan") return degraded.scan as unknown as T;
            if (name === "health") return degraded.health as unknown as T;
            throw new Error(`unexpected tool ${name}`);
          },
        } as any;
      },
    } as any;
    const config = makeConfig({ nudge: "agent_end", nudgeThreshold: 200 });
    registerNudgeHooks(captured.pi, { getConfig: () => config, registry });

    const ctx = makeCtx("/root");
    await emit(captured.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
    await flush();
    await emit(captured.handlers, "tool_call", { type: "tool_call", toolCallId: "e1", toolName: "edit" }, ctx);
    await emit(captured.handlers, "tool_result", { type: "tool_result", toolCallId: "e1", toolName: "edit", isError: false }, ctx);
    await emit(captured.handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);
    await flush(50);

    // No scan ran (a timeout kill would lose the session baseline) and nothing was sent.
    expect(registry.getClientCalls).toBe(0);
    expect(captured.sentMessages).toEqual([]);
  });
});
