#!/usr/bin/env node
// Fake `sentrux` CLI for unit tests. Driven entirely by env vars so tests can inject
// `{command: process.execPath, prefixArgs: [thisFile]}` as `cli.ts`'s CliCommand and get a real
// subprocess round-trip through process.ts, without needing the real binary.
//
// Modes (checked in order):
//   FAKE_SENTRUX_SCENARIO_DIR=<dir>   replay <dir>/{stdout,stderr,exit_code}.txt verbatim
//                                     (used to replay captured test/fixtures/v0.5.7/{check,gate}/* dirs)
//   FAKE_SENTRUX_STDOUT / FAKE_SENTRUX_STDERR / FAKE_SENTRUX_EXIT_CODE
//                                     inline canned output, for synthetic edge cases
//
// For `gate --save`, if the scenario dir (or FAKE_SENTRUX_BASELINE_JSON) has baseline content,
// it is written to `<root>/.sentrux/baseline.json` before exiting, mirroring what the real CLI does.
//
// `mcp` mode (argv[0] === "mcp"): a scriptable fake MCP server for mcp-client.test.ts / servers.test.ts.
// See runMcpMode() below for its env vars.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

if (args[0] === "mcp") {
  runMcpMode();
} else {
  runClassicMode();
}

function runClassicMode() {
  const root = args[args.length - 1];
  const isSave = args.includes("--save");

  function tryRead(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }

  let stdout;
  let stderr;
  let exitCode;
  let baselineJson;

  const scenarioDir = process.env.FAKE_SENTRUX_SCENARIO_DIR;
  if (scenarioDir) {
    stdout = tryRead(join(scenarioDir, "stdout.txt")) ?? "";
    stderr = tryRead(join(scenarioDir, "stderr.txt")) ?? "";
    exitCode = Number((tryRead(join(scenarioDir, "exit_code.txt")) ?? "0").trim());
    baselineJson = tryRead(join(scenarioDir, "baseline.json"));
  } else {
    stdout = process.env.FAKE_SENTRUX_STDOUT ?? "";
    stderr = process.env.FAKE_SENTRUX_STDERR ?? "";
    exitCode = Number(process.env.FAKE_SENTRUX_EXIT_CODE ?? "0");
    baselineJson = process.env.FAKE_SENTRUX_BASELINE_JSON;
  }

  if (isSave && baselineJson && root) {
    const sentruxDir = join(root, ".sentrux");
    if (!existsSync(sentruxDir)) mkdirSync(sentruxDir, { recursive: true });
    writeFileSync(join(sentruxDir, "baseline.json"), baselineJson, "utf8");
  }

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

// --- mcp mode ---
//
// Speaks the same newline-delimited JSON-RPC protocol as the real `sentrux mcp` (no
// Content-Length framing), with exactly the 9 tools and shapes captured in
// test/fixtures/v0.5.7/mcp/transcript.jsonl, plus scriptable misbehaviour for
// mcp-client.test.ts:
//
//   FAKE_SENTRUX_MCP_VERSION           serverInfo.version (default "0.5.7")
//   FAKE_SENTRUX_MCP_PROTOCOL_VERSION  initialize's protocolVersion (default "2024-11-05")
//   FAKE_SENTRUX_MCP_MISSING_TOOL      omit this tool from tools/list AND from tools/call ("Unknown tool")
//   FAKE_SENTRUX_MCP_ERROR_TOOL        this tool's tools/call returns isError:true
//   FAKE_SENTRUX_MCP_ERROR_TEXT        isError text for FAKE_SENTRUX_MCP_ERROR_TOOL (default "boom")
//   FAKE_SENTRUX_MCP_RPC_ERROR_METHOD  this JSON-RPC method gets a top-level {error} instead of a result
//   FAKE_SENTRUX_MCP_RPC_ERROR_TEXT    message for FAKE_SENTRUX_MCP_RPC_ERROR_METHOD (default "fake rpc error")
//   FAKE_SENTRUX_MCP_GARBAGE_AFTER     emit one non-JSON stdout line right after replying to this method
//   FAKE_SENTRUX_MCP_HANG_TOOL         this tool's tools/call never replies (to trigger a client timeout)
//   FAKE_SENTRUX_MCP_CRASH_TOOL        this tool's tools/call exits(1) immediately, without replying
//   FAKE_SENTRUX_MCP_IGNORE_EOF        when set, stdin EOF does NOT exit the process (forces the client's
//                                      close() to fall through to SIGTERM/SIGKILL)
function runMcpMode() {
  const settings = readMcpSettings();
  const state = { baseline: undefined, garbageEmitted: false };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const parsed = parseMcpLine(line);
    if (parsed) handleMcpMessage(settings, state, parsed[0]);
  });
  rl.on("close", () => {
    if (!settings.ignoreEof) process.exit(0);
  });
}

function readMcpSettings() {
  return {
    allTools: ["scan", "rescan", "session_start", "session_end", "health", "check_rules", "git_stats", "dsm", "test_gaps"],
    serverVersion: process.env.FAKE_SENTRUX_MCP_VERSION ?? "0.5.7",
    protocolVersion: process.env.FAKE_SENTRUX_MCP_PROTOCOL_VERSION ?? "2024-11-05",
    missingTool: process.env.FAKE_SENTRUX_MCP_MISSING_TOOL,
    errorTool: process.env.FAKE_SENTRUX_MCP_ERROR_TOOL,
    errorText: process.env.FAKE_SENTRUX_MCP_ERROR_TEXT ?? "boom",
    rpcErrorMethod: process.env.FAKE_SENTRUX_MCP_RPC_ERROR_METHOD,
    rpcErrorText: process.env.FAKE_SENTRUX_MCP_RPC_ERROR_TEXT ?? "fake rpc error",
    garbageAfter: process.env.FAKE_SENTRUX_MCP_GARBAGE_AFTER,
    hangTool: process.env.FAKE_SENTRUX_MCP_HANG_TOOL,
    crashTool: process.env.FAKE_SENTRUX_MCP_CRASH_TOOL,
    ignoreEof: Boolean(process.env.FAKE_SENTRUX_MCP_IGNORE_EOF),
  };
}

function mcpReply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function mcpReplyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function maybeEmitGarbage(settings, state, afterMethod) {
  if (!state.garbageEmitted && settings.garbageAfter === afterMethod) {
    state.garbageEmitted = true;
    process.stdout.write("not-json-garbage-line\n");
  }
}

function mcpToolList(settings) {
  return settings.allTools.filter((name) => name !== settings.missingTool).map((name) => ({
    name,
    description: `fake ${name}`,
    inputSchema: { type: "object", properties: {} },
  }));
}

function mcpToolResult(name, callArgs, state) {
  switch (name) {
    case "scan":
      return { scanned: callArgs?.path, quality_signal: 4674, files: 29, lines: 107, import_edges: 22 };
    case "rescan":
      return { status: "Rescanned", quality_signal: 4674, files: 29 };
    case "session_start":
      state.baseline = { quality_signal: 4674 };
      return { message: "Call 'session_end' after making changes to see the diff", quality_signal: 4674, status: "Baseline saved" };
    case "session_end":
      if (!state.baseline) {
        return { errorText: "No baseline saved. Call 'session_start' first." };
      }
      return {
        pass: true,
        signal_before: 4674,
        signal_after: 4674,
        signal_delta: 0,
        coupling_change: [0, 0],
        cycles_change: [0, 0],
        violations: [],
        summary: "Quality stable or improved",
      };
    case "health":
      return { quality_signal: 4674, bottleneck: "none", root_causes: {}, total_import_edges: 22, cross_module_edges: 0 };
    case "check_rules":
      return {
        pass: true,
        rules_checked: 0,
        violation_count: 0,
        violations: [],
        summary: "ok",
        truncated: { message: "Checking up to 3 rules. More available with sentrux Pro.", rules_checked: 0, total_rules_defined: 0 },
      };
    case "git_stats":
      return {
        lookback_days: callArgs?.days ?? 30,
        commits_analyzed: 0,
        files_with_churn: 0,
        single_author_ratio: 0,
        coupling_pairs_found: 0,
        hotspot_count: 0,
        bus_factor_solo_files: 0,
      };
    case "dsm":
      return {
        size: 0,
        density: 0,
        above_diagonal: 0,
        below_diagonal: 0,
        propagation_cost: 0,
        level_breaks: 0,
        interpretation: "",
        clusters: [],
      };
    case "test_gaps":
      return { coverage_score: 0, source_files: 0, test_files: 0, tested: 0, untested: 0, coverage_ratio: 0 };
    default:
      return undefined;
  }
}

function parseMcpLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return [JSON.parse(trimmed)];
  } catch {
    return undefined;
  }
}

function handleMcpMessage(settings, state, msg) {
  const { method, id, params } = msg;
  if (settings.rpcErrorMethod && method === settings.rpcErrorMethod) {
    if (id !== undefined) mcpReplyError(id, -32000, settings.rpcErrorText);
    return;
  }
  if (method === "initialize") {
    mcpReply(id, { protocolVersion: settings.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sentrux", version: settings.serverVersion } });
    maybeEmitGarbage(settings, state, "initialize");
    return;
  }
  if (method === "notifications/initialized") {
    maybeEmitGarbage(settings, state, "notifications/initialized");
    return;
  }
  if (method === "tools/list") {
    mcpReply(id, { tools: mcpToolList(settings) });
    maybeEmitGarbage(settings, state, "tools/list");
    return;
  }
  if (method === "ping") {
    mcpReply(id, {});
    maybeEmitGarbage(settings, state, "ping");
    return;
  }
  if (method === "tools/call") {
    handleToolsCall(settings, state, id, params);
    return;
  }
  if (id !== undefined) {
    mcpReplyError(id, -32601, `Unknown method: ${method}`);
  }
}

function handleToolsCall(settings, state, id, params) {
  const name = params?.name;
  const callArgs = params?.arguments ?? {};
  if (settings.crashTool && name === settings.crashTool) {
    process.exit(1);
  }
  if (settings.hangTool && name === settings.hangTool) {
    return;
  }
  if (!settings.allTools.includes(name) || name === settings.missingTool) {
    mcpReply(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
    return;
  }
  if (settings.errorTool && name === settings.errorTool) {
    mcpReply(id, { content: [{ type: "text", text: settings.errorText }], isError: true });
    return;
  }
  const result = mcpToolResult(name, callArgs, state);
  if (result && result.errorText) {
    mcpReply(id, { content: [{ type: "text", text: result.errorText }], isError: true });
    return;
  }
  mcpReply(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
  maybeEmitGarbage(settings, state, "tools/call");
}
