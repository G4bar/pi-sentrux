import { readFile } from "node:fs/promises";

export type NudgeMode = "off" | "agent_end";

export interface SentruxConfig {
  binaryPath?: string;
  skipGrammarDownload: boolean;
  warmup: boolean;
  cliTimeoutMs: number;
  mcpStartTimeoutMs: number;
  mcpCallTimeoutMs: number;
  maxServers: number;
  maxOutputBytes: number;
  maxOutputLines: number;
  untrackedWarning: boolean;
  allowBaselineWrite: boolean;
  nudge: NudgeMode;
  nudgeThreshold: number;
}

export const DEFAULT_CONFIG: SentruxConfig = {
  skipGrammarDownload: false,
  warmup: true,
  cliTimeoutMs: 300_000,
  mcpStartTimeoutMs: 300_000,
  mcpCallTimeoutMs: 120_000,
  maxServers: 3,
  maxOutputBytes: 8192,
  maxOutputLines: 200,
  untrackedWarning: true,
  allowBaselineWrite: true,
  nudge: "off",
  nudgeThreshold: 200,
};

type KeyType = "string" | "boolean" | "number" | "nudge";

const KEY_TYPES: Record<keyof SentruxConfig, KeyType> = {
  binaryPath: "string",
  skipGrammarDownload: "boolean",
  warmup: "boolean",
  cliTimeoutMs: "number",
  mcpStartTimeoutMs: "number",
  mcpCallTimeoutMs: "number",
  maxServers: "number",
  maxOutputBytes: "number",
  maxOutputLines: "number",
  untrackedWarning: "boolean",
  allowBaselineWrite: "boolean",
  nudge: "nudge",
  nudgeThreshold: "number",
};

const ALL_KEYS = Object.keys(KEY_TYPES) as (keyof SentruxConfig)[];

/** Keys a trusted project config (`.pi/sentrux.json`) may set. `binaryPath` is deliberately excluded. */
export const PROJECT_ALLOWED_KEYS: readonly (keyof SentruxConfig)[] = [
  "nudge",
  "nudgeThreshold",
  "maxOutputBytes",
  "maxOutputLines",
  "untrackedWarning",
];

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export interface LoadConfigOptions {
  globalConfigPath: string;
  projectConfigPath: string;
  isProjectTrusted: boolean;
  env: NodeJS.ProcessEnv;
  notify: NotifyFn;
}

async function readJsonFile(path: string, notify: NotifyFn): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return undefined;
    notify(`pi-sentrux: could not read ${path}: ${(err as Error).message}`, "warning");
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    notify(`pi-sentrux: invalid JSON in ${path}: ${(err as Error).message}. Using defaults.`, "warning");
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    notify(`pi-sentrux: ${path} must contain a JSON object. Using defaults.`, "warning");
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function applyKeys(config: SentruxConfig, data: Record<string, unknown>, allowedKeys: readonly (keyof SentruxConfig)[]): void {
  for (const key of allowedKeys) {
    if (!(key in data)) continue;
    const value = data[key];
    const type = KEY_TYPES[key];
    if (type === "nudge") {
      if (value === "off" || value === "agent_end") {
        config.nudge = value;
      }
      continue;
    }
    if (typeof value === type) {
      // SAFETY: KEY_TYPES[key] was just checked against typeof value, so this assignment matches SentruxConfig's field type for `key`.
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Numeric config values are only typeof-checked on load, so a `0` or negative
 * value would silently break behaviour (empty output, instant timeouts, eviction
 * on every spawn). Clamp back to defaults with a warning instead. */
function enforceNumericBounds(config: SentruxConfig, notify: NotifyFn): void {
  const positiveInts: (keyof SentruxConfig)[] = ["maxServers", "maxOutputBytes", "maxOutputLines"];
  for (const key of positiveInts) {
    const value = config[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      notify(`pi-sentrux: ignoring invalid config ${key}=${JSON.stringify(value)}; using default ${DEFAULT_CONFIG[key]}.`, "warning");
      // SAFETY: `key` is one of the three numeric positive-int keys of SentruxConfig, and DEFAULT_CONFIG[key] holds that same field's default.
      (config as unknown as Record<string, unknown>)[key] = DEFAULT_CONFIG[key];
    }
  }
  const positiveTimeouts: (keyof SentruxConfig)[] = ["cliTimeoutMs", "mcpStartTimeoutMs", "mcpCallTimeoutMs"];
  for (const key of positiveTimeouts) {
    if (!isPositiveFinite(config[key])) {
      notify(`pi-sentrux: ignoring invalid config ${key}=${JSON.stringify(config[key])}; using default ${DEFAULT_CONFIG[key]}.`, "warning");
      // SAFETY: `key` is one of the three numeric timeout keys of SentruxConfig, and DEFAULT_CONFIG[key] holds that same field's default.
      (config as unknown as Record<string, unknown>)[key] = DEFAULT_CONFIG[key];
    }
  }
  if (typeof config.nudgeThreshold !== "number" || !Number.isFinite(config.nudgeThreshold) || config.nudgeThreshold < 0) {
    notify(
      `pi-sentrux: ignoring invalid config nudgeThreshold=${JSON.stringify(config.nudgeThreshold)}; using default ${DEFAULT_CONFIG.nudgeThreshold}.`,
      "warning",
    );
    config.nudgeThreshold = DEFAULT_CONFIG.nudgeThreshold;
  }
}

/**
 * Resolves config from defaults, the global config file, the project config
 * file (trusted projects only, restricted key set), then SENTRUX_BIN which
 * overrides `binaryPath` alone. Never throws; malformed files fall back to
 * defaults with a notify() warning.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<SentruxConfig> {
  const config: SentruxConfig = { ...DEFAULT_CONFIG };

  const globalData = await readJsonFile(options.globalConfigPath, options.notify);
  if (globalData) applyKeys(config, globalData, ALL_KEYS);

  if (options.isProjectTrusted) {
    const projectData = await readJsonFile(options.projectConfigPath, options.notify);
    if (projectData) applyKeys(config, projectData, PROJECT_ALLOWED_KEYS);
  }

  const envBin = options.env.SENTRUX_BIN;
  if (envBin) {
    config.binaryPath = envBin;
  }

  enforceNumericBounds(config, options.notify);

  return config;
}

/**
 * Child-process env for Sentrux invocations. `skipGrammarDownload` is
 * advanced/unsupported: it sets `SENTRUX_SKIP_GRAMMAR_DOWNLOAD=1` for the
 * spawned CLI/MCP process, and with zero cached grammars scanning likely
 * cannot parse anything.
 */
export function sentruxChildEnv(config: SentruxConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!config.skipGrammarDownload) return base;
  return { ...base, SENTRUX_SKIP_GRAMMAR_DOWNLOAD: "1" };
}
