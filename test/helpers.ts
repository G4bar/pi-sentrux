import { DEFAULT_CONFIG, type SentruxConfig } from "../extensions/sentrux/config.ts";
import type { McpClientLike } from "../extensions/sentrux/types.ts";

export function makeFakePi() {
  const registered: Record<string, any> = {};
  const pi = { registerTool: (tool: any) => { registered[tool.name] = tool; } } as any;
  return { pi, registered };
}

export function makeCtx(cwd: string): any {
  return { cwd };
}

export function makeConfig(overrides: Partial<SentruxConfig> = {}): SentruxConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export function makeFakeMcpClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
  return {
    isAlive: true,
    generation: 0,
    pid: undefined,
    start: async () => undefined,
    callTool: async () => {
      throw new Error("not exercised");
    },
    close: async () => undefined,
    forceKillSync: () => undefined,
    ...overrides,
  };
}

export function scanHealthCallTool(step: { scan: unknown; health: unknown }, calls: string[]) {
  return async <T>(name: string): Promise<T> => {
    calls.push(name);
    if (name === "scan") return step.scan as T;
    if (name === "health") return step.health as T;
    throw new Error(`unexpected tool ${name}`);
  };
}
