import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { BinaryStatus } from "./runtime/binary.ts";
import { resolveBinary, warmupFailureStatus } from "./runtime/binary.ts";
import { registerStatusCommand } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig, sentruxChildEnv, type SentruxConfig } from "./config.ts";
import { McpClient } from "./mcp/mcp-client.ts";
import { registerNudgeHooks } from "./nudge.ts";
import { McpServerRegistry } from "./mcp/servers.ts";
import { registerCheckRulesTool, registerGateTool, registerInsightsTool, registerScanTool, registerSessionTool } from "./tools.ts";

const CLIENT_VERSION = "0.1.0";

/** Process-exit safety net, registered once at module scope: one `process.once("exit")`
 * listener per extension load would stack up on `/reload` until MaxListenersExceededWarning.
 * The session_shutdown hook is the normal path; this only covers exits that skip it. */
const exitTrackedRegistries = new Set<McpServerRegistry>();
let exitHookInstalled = false;

function trackRegistryForExit(registry: McpServerRegistry): void {
  exitTrackedRegistries.add(registry);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const tracked of exitTrackedRegistries) {
      try {
        tracked.killAllSync();
      } catch {
        // Best-effort shutdown path; nothing to report during process exit.
      }
    }
  });
}

async function runWarmup(promise: Promise<BinaryStatus>, setStatus: (key: string, text: string | undefined) => void): Promise<void> {
  let text: string;
  try {
    const status = await promise;
    text = `sentrux ${status.version.major}.${status.version.minor}.${status.version.patch}`;
  } catch (err) {
    text = warmupFailureStatus(err);
  }
  try {
    // The session can be replaced, reloaded, or shut down while warm-up is still in
    // flight; ctx.ui then throws "stale ctx". There is nothing to update in that case.
    setStatus("sentrux", text);
  } catch {
    // Intentionally swallowed; see comment above.
  }
}

export default function sentrux(pi: ExtensionAPI): void {
  let config: SentruxConfig | undefined;
  let warmupPromise: Promise<BinaryStatus> | undefined;

  const agentDir = getAgentDir();
  const globalConfigPath = join(agentDir, "pi-sentrux", "config.json");

  // Servers spawn lazily on first tool call (Phase 4); `createClient` reads `config` by
  // closure so a config reload before that first call is picked up without recreating the registry.
  const registry = new McpServerRegistry({
    maxServers: () => (config ?? DEFAULT_CONFIG).maxServers,
    createClient: (root) =>
      new McpClient({
        cwd: root,
        clientVersion: CLIENT_VERSION,
        startTimeoutMs: (config ?? DEFAULT_CONFIG).mcpStartTimeoutMs,
        callTimeoutMs: (config ?? DEFAULT_CONFIG).mcpCallTimeoutMs,
        env: sentruxChildEnv(config ?? DEFAULT_CONFIG),
        resolveCommand: async () => {
          const cfg = config ?? DEFAULT_CONFIG;
          const status = await resolveBinary({
            configuredPath: cfg.binaryPath,
            env: process.env,
            agentDir,
            cliTimeoutMs: cfg.cliTimeoutMs,
          });
          return { command: status.path };
        },
      }),
  });

  // Safety net: pi's own session_shutdown hook below is the normal path;
  // trackRegistryForExit covers a process exit that skips it (e.g. an uncaught crash).
  trackRegistryForExit(registry);

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig({
      globalConfigPath,
      projectConfigPath: join(ctx.cwd, ".pi", "sentrux.json"),
      isProjectTrusted: ctx.isProjectTrusted(),
      env: process.env,
      notify: (message, type) => ctx.ui.notify(message, type),
    });

    if (!config.warmup) {
      ctx.ui.setStatus("sentrux", "sentrux: warm-up disabled");
      return;
    }

    warmupPromise = resolveBinary({
      configuredPath: config.binaryPath,
      env: process.env,
      agentDir,
      cliTimeoutMs: config.cliTimeoutMs,
    });

    // Do not await: warm-up can take up to cliTimeoutMs (first run downloads grammars).
    void runWarmup(warmupPromise, (key, text) => ctx.ui.setStatus(key, text));
  });

  pi.on("session_shutdown", async () => {
    await registry.closeAll();
  });

  registerStatusCommand(pi, {
    getConfig: () => config,
    getWarmup: () => warmupPromise,
    agentDir,
    globalConfigPath,
    registry,
  });

  const toolDeps = { getConfig: () => config, agentDir };
  registerCheckRulesTool(pi, toolDeps);
  registerGateTool(pi, toolDeps);

  const mcpToolDeps = { ...toolDeps, registry };
  registerScanTool(pi, mcpToolDeps);
  registerSessionTool(pi, mcpToolDeps);
  registerInsightsTool(pi, mcpToolDeps);

  // Opt-in post-edit nudge (D5, §6.6). Off by default; enabled with `nudge:"agent_end"`.
  // The hooks check the flag first, so with the nudge off they do no work after warm-up.
  registerNudgeHooks(pi, { getConfig: () => config, registry });
}
