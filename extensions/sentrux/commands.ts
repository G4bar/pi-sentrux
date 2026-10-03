import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { findMissingSharedLibraries, NOT_FOUND_MESSAGE, pathExists, resolveBinary, type BinaryStatus } from "./binary.ts";
import type { SentruxConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { ensureTelemetryOptOut, formatUnsupportedPlatformMessage, getReleaseEntry, installBinary, installTargetPath, type InstallBinaryOptions } from "./install.ts";
import type { McpServerRegistry } from "./servers.ts";

export interface StatusDeps {
  getConfig: () => SentruxConfig | undefined;
  getWarmup: () => Promise<BinaryStatus> | undefined;
  agentDir: string;
  globalConfigPath: string;
  registry: McpServerRegistry;
}

function sourceLabel(status: BinaryStatus): string {
  // config.ts folds SENTRUX_BIN into `binaryPath` (it overrides any file-configured value), so
  // binary.ts's own "config" source is ambiguous here; prefer the more specific env attribution.
  if (process.env.SENTRUX_BIN && status.path === process.env.SENTRUX_BIN) {
    return "SENTRUX_BIN";
  }
  switch (status.source) {
    case "config":
      return "global config (binaryPath)";
    case "env":
      return "SENTRUX_BIN";
    case "path":
      return "PATH";
    case "managed":
      return "managed install";
  }
}

export async function buildStatusReport(deps: StatusDeps, ctx: ExtensionCommandContext): Promise<string> {
  const config = deps.getConfig();
  const lines: string[] = [];

  let binaryStatus: BinaryStatus | undefined;
  let binaryError: Error | undefined;

  const warmup = deps.getWarmup();
  try {
    binaryStatus = warmup
      ? await warmup
      : await resolveBinary({
          configuredPath: config?.binaryPath,
          env: process.env,
          agentDir: deps.agentDir,
          cliTimeoutMs: config?.cliTimeoutMs,
        });
  } catch (err) {
    binaryError = err as Error;
  }

  if (binaryStatus) {
    const pro = binaryStatus.version.pro ? " (Pro)" : "";
    lines.push(`Binary: ${binaryStatus.path} (${sourceLabel(binaryStatus)})`);
    lines.push(`Version: sentrux ${binaryStatus.version.major}.${binaryStatus.version.minor}.${binaryStatus.version.patch}${pro}`);
    if (binaryStatus.versionWarning) {
      lines.push(`Warning: ${binaryStatus.versionWarning}`);
    }
    const missingLibs = await findMissingSharedLibraries(binaryStatus.path);
    if (missingLibs && missingLibs.length > 0) {
      lines.push("Missing shared libraries (ldd):");
      for (const lib of missingLibs) lines.push(`  ${lib}`);
    }
  } else {
    lines.push(binaryError?.message ?? NOT_FOUND_MESSAGE);
  }

  const sentruxHome = join(homedir(), ".sentrux");
  lines.push(`~/.sentrux exists: ${(await pathExists(sentruxHome)) ? "yes" : "no"}`);
  lines.push(`~/.sentrux/telemetry_opt_out exists: ${(await pathExists(join(sentruxHome, "telemetry_opt_out"))) ? "yes" : "no"}`);

  const globalConfigPresent = await pathExists(deps.globalConfigPath);
  lines.push(`Global config: ${deps.globalConfigPath}${globalConfigPresent ? "" : " (not present, using defaults)"}`);

  const projectConfigPath = join(ctx.cwd, ".pi", "sentrux.json");
  if (ctx.isProjectTrusted()) {
    const projectConfigPresent = await pathExists(projectConfigPath);
    lines.push(`Project config: ${projectConfigPath}${projectConfigPresent ? "" : " (not present)"}`);
  } else {
    lines.push("Project config: not loaded (project not trusted)");
  }

  const handles = deps.registry.listHandles();
  if (handles.length === 0) {
    lines.push("Active servers: none");
  } else {
    lines.push(`Active servers (${handles.length}):`);
    for (const h of handles) {
      const sessionState = h.lostSession ? "session lost (server restarted)" : h.hasSession ? "session baseline active" : "no session";
      const liveness = h.alive ? `pid ${h.pid ?? "?"}` : "not running";
      lines.push(`  ${h.root} — ${liveness}, generation ${h.generation}, ${sessionState}`);
    }
  }

  return lines.join("\n");
}

export function registerStatusCommand(pi: ExtensionAPI, deps: StatusDeps): void {
  pi.registerCommand("sentrux", {
    description: "Sentrux status, install, restart, telemetry-off",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["status", "install", "restart", "telemetry-off"];
      const filtered = subcommands.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/)[0] || "status";
      try {
        switch (subcommand) {
          case "status": {
            const report = await buildStatusReport(deps, ctx);
            ctx.ui.notify(report, "info");
            return;
          }
          case "install":
            await runInstallCommand(deps, ctx);
            return;
          case "restart":
            await runRestartCommand(deps, ctx);
            return;
          case "telemetry-off":
            await runTelemetryOffCommand(deps, ctx);
            return;
          default:
            ctx.ui.notify(`pi-sentrux: unknown subcommand "${subcommand}". Usage: /sentrux [status|install|restart|telemetry-off]`, "warning");
            return;
        }
      } catch (err) {
        ctx.ui.notify(`pi-sentrux: /sentrux ${subcommand} failed: ${(err as Error).message}`, "error");
      }
    },
  });
}

export interface InstallCommandOverrides {
  installFn?: (options: InstallBinaryOptions) => Promise<{ path: string; version: string }>;
}

/** `/sentrux install`: opt-in download of the pinned v0.5.7 asset (§6.4). Never runs automatically. */
export async function runInstallCommand(deps: StatusDeps, ctx: ExtensionCommandContext, overrides: InstallCommandOverrides = {}): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("/sentrux install needs a dialog-capable UI to confirm the download. Re-run it in interactive mode.");
  }
  const entry = getReleaseEntry();
  if (!entry) {
    ctx.ui.notify(`pi-sentrux: ${formatUnsupportedPlatformMessage()}`, "error");
    return;
  }
  const target = installTargetPath(deps.agentDir);
  const confirmed = await ctx.ui.confirm(
    "Install Sentrux v0.5.7?",
    `Download ${entry.url} (sha256 ${entry.sha256}) into the managed cache at ${target}? Nothing is downloaded without this confirmation.`,
  );
  if (!confirmed) {
    ctx.ui.notify("pi-sentrux: install cancelled.", "info");
    return;
  }
  const installFn = overrides.installFn ?? installBinary;
  const result = await installFn({ agentDir: deps.agentDir, signal: ctx.signal ?? undefined });
  ctx.ui.notify(`pi-sentrux: installed ${result.version} at ${result.path}; the first run downloads the grammars (~8–30 MB) into ~/.sentrux.`, "info");
}

export interface RestartCommandOverrides {
  resolveFn?: (options: { configuredPath?: string; env: NodeJS.ProcessEnv; agentDir: string; cliTimeoutMs?: number }) => Promise<BinaryStatus>;
}

/** `/sentrux restart`: close all MCP servers (session baselines are lost), then re-resolve the binary. */
export async function runRestartCommand(deps: StatusDeps, ctx: ExtensionCommandContext, overrides: RestartCommandOverrides = {}): Promise<void> {
  const withSession = deps.registry.listHandles().filter((h) => h.hasSession);
  if (withSession.length > 0) {
    if (!ctx.hasUI) {
      throw new Error("/sentrux restart needs a dialog-capable UI to confirm: closing the servers loses session baselines. Re-run it in interactive mode.");
    }
    const confirmed = await ctx.ui.confirm(
      "Restart Sentrux servers?",
      `${withSession.length} server(s) have an active session baseline, which will be lost. Close all servers and re-resolve the binary?`,
    );
    if (!confirmed) {
      ctx.ui.notify("pi-sentrux: restart cancelled.", "info");
      return;
    }
  }
  await deps.registry.closeAll();
  const config = deps.getConfig() ?? DEFAULT_CONFIG;
  const resolveFn = overrides.resolveFn ?? resolveBinary;
  const status = await resolveFn({ configuredPath: config.binaryPath, env: process.env, agentDir: deps.agentDir, cliTimeoutMs: config.cliTimeoutMs });
  ctx.ui.notify(`pi-sentrux: servers restarted; binary ${status.path} (sentrux ${status.version.major}.${status.version.minor}.${status.version.patch}).`, "info");
}

export interface TelemetryOffCommandOverrides {
  ensureFn?: () => Promise<{ path: string; alreadyExisted: boolean }>;
}

/** `/sentrux telemetry-off` (D4): confirm, then create the opt-out file only. Idempotent; never deletes. */
export async function runTelemetryOffCommand(_deps: StatusDeps, ctx: ExtensionCommandContext, overrides: TelemetryOffCommandOverrides = {}): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("/sentrux telemetry-off needs a dialog-capable UI to confirm. Re-run it in interactive mode.");
  }
  const confirmed = await ctx.ui.confirm(
    "Turn off Sentrux telemetry?",
    "This writes the global ~/.sentrux/telemetry_opt_out; affects all Sentrux use.",
  );
  if (!confirmed) {
    ctx.ui.notify("pi-sentrux: telemetry-off cancelled.", "info");
    return;
  }
  const ensureFn = overrides.ensureFn ?? ensureTelemetryOptOut;
  const { path, alreadyExisted } = await ensureFn();
  ctx.ui.notify(
    alreadyExisted ? `pi-sentrux: telemetry already off (${path} exists).` : `pi-sentrux: telemetry turned off (${path} created). No data is deleted.`,
    "info",
  );
}
