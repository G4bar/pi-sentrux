import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, sentruxChildEnv } from "../../extensions/sentrux/config.ts";

describe("loadConfig", () => {
  let dir: string;
  let notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sentrux-config-"));
    notifications = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function notify(message: string, type?: "info" | "warning" | "error"): void {
    notifications.push({ message, type });
  }

  it("returns defaults when no config files exist", async () => {
    const config = await loadConfig({
      globalConfigPath: join(dir, "missing-global.json"),
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: true,
      env: {},
      notify,
    });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(notifications).toEqual([]);
  });

  it("applies global config over defaults", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ warmup: false, maxServers: 5, binaryPath: "/opt/sentrux" }));

    const config = await loadConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: false,
      env: {},
      notify,
    });

    expect(config.warmup).toBe(false);
    expect(config.maxServers).toBe(5);
    expect(config.binaryPath).toBe("/opt/sentrux");
  });

  it("only merges project config keys when the project is trusted", async () => {
    const projectPath = join(dir, "project.json");
    await writeFile(projectPath, JSON.stringify({ nudge: "agent_end", nudgeThreshold: 999 }));

    const untrusted = await loadConfig({
      globalConfigPath: join(dir, "missing-global.json"),
      projectConfigPath: projectPath,
      isProjectTrusted: false,
      env: {},
      notify,
    });
    expect(untrusted.nudge).toBe("off");
    expect(untrusted.nudgeThreshold).toBe(DEFAULT_CONFIG.nudgeThreshold);

    const trusted = await loadConfig({
      globalConfigPath: join(dir, "missing-global.json"),
      projectConfigPath: projectPath,
      isProjectTrusted: true,
      env: {},
      notify,
    });
    expect(trusted.nudge).toBe("agent_end");
    expect(trusted.nudgeThreshold).toBe(999);
  });

  it("never lets a trusted project config set binaryPath or other non-allowed keys", async () => {
    const projectPath = join(dir, "project.json");
    await writeFile(
      projectPath,
      JSON.stringify({ binaryPath: "/malicious/sentrux", skipGrammarDownload: true, allowBaselineWrite: false }),
    );

    const config = await loadConfig({
      globalConfigPath: join(dir, "missing-global.json"),
      projectConfigPath: projectPath,
      isProjectTrusted: true,
      env: {},
      notify,
    });

    expect(config.binaryPath).toBeUndefined();
    expect(config.skipGrammarDownload).toBe(false);
    expect(config.allowBaselineWrite).toBe(true);
  });

  it("lets SENTRUX_BIN override binaryPath regardless of its source", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ binaryPath: "/opt/sentrux-from-config" }));

    const config = await loadConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: false,
      env: { SENTRUX_BIN: "/opt/sentrux-from-env" },
      notify,
    });

    expect(config.binaryPath).toBe("/opt/sentrux-from-env");
  });

  it("falls back to defaults and warns on invalid JSON", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, "{ not valid json");

    const config = await loadConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: false,
      env: {},
      notify,
    });

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("warning");
    expect(notifications[0]?.message).toContain("invalid JSON");
  });

  it("warns and falls back to defaults when the config file is not a JSON object", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify(["not", "an", "object"]));

    const config = await loadConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: false,
      env: {},
      notify,
    });

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(notifications[0]?.type).toBe("warning");
  });

  it("ignores keys of the wrong type instead of throwing", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ warmup: "yes", maxServers: "five" }));

    const config = await loadConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: false,
      env: {},
      notify,
    });

    expect(config.warmup).toBe(DEFAULT_CONFIG.warmup);
    expect(config.maxServers).toBe(DEFAULT_CONFIG.maxServers);
  });

  it("does not throw when the global config directory does not exist at all", async () => {
    const config = await loadConfig({
      globalConfigPath: join(dir, "no", "such", "dir", "config.json"),
      projectConfigPath: join(dir, "no", "such", "dir", "sentrux.json"),
      isProjectTrusted: true,
      env: {},
      notify,
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("clamps non-positive numeric values back to defaults with a warning", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(
      globalPath,
      JSON.stringify({ maxOutputBytes: 0, maxOutputLines: -3, maxServers: 0, cliTimeoutMs: -100, mcpCallTimeoutMs: 0 }),
    );

    const config = await loadConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: false,
      env: {},
      notify,
    });

    expect(config.maxOutputBytes).toBe(DEFAULT_CONFIG.maxOutputBytes);
    expect(config.maxOutputLines).toBe(DEFAULT_CONFIG.maxOutputLines);
    expect(config.maxServers).toBe(DEFAULT_CONFIG.maxServers);
    expect(config.cliTimeoutMs).toBe(DEFAULT_CONFIG.cliTimeoutMs);
    expect(config.mcpCallTimeoutMs).toBe(DEFAULT_CONFIG.mcpCallTimeoutMs);
    expect(notifications.length).toBeGreaterThanOrEqual(5);
    expect(notifications.every((n) => n.type === "warning")).toBe(true);
  });

  it("keeps valid numeric values without warnings", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ maxOutputBytes: 4096, maxServers: 5, cliTimeoutMs: 60_000 }));

    const config = await loadConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing-project.json"),
      isProjectTrusted: false,
      env: {},
      notify,
    });

    expect(config.maxOutputBytes).toBe(4096);
    expect(config.maxServers).toBe(5);
    expect(config.cliTimeoutMs).toBe(60_000);
    expect(notifications).toEqual([]);
  });
});

describe("sentruxChildEnv", () => {
  it("returns the base env unchanged when skipGrammarDownload is false", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(sentruxChildEnv({ ...DEFAULT_CONFIG, skipGrammarDownload: false }, base)).toBe(base);
  });

  it("sets SENTRUX_SKIP_GRAMMAR_DOWNLOAD=1 when skipGrammarDownload is true", () => {
    const env = sentruxChildEnv({ ...DEFAULT_CONFIG, skipGrammarDownload: true }, { PATH: "/usr/bin" });
    expect(env.SENTRUX_SKIP_GRAMMAR_DOWNLOAD).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
  });
});
