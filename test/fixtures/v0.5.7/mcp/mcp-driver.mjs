#!/usr/bin/env node
// Drives `<bin> mcp` over stdio with newline-delimited JSON-RPC (no
// Content-Length framing) and records the full transcript as JSONL.
// Usage: node mcp-driver.mjs <bin> <root-dir> <out.jsonl>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, appendFileSync } from "node:fs";

const [, , bin, root, outPath] = process.argv;
if (!bin || !root || !outPath) {
  console.error("usage: mcp-driver.mjs <bin> <root-dir> <out.jsonl>");
  process.exit(2);
}

writeFileSync(outPath, "");
function log(entry) {
  appendFileSync(outPath, JSON.stringify(entry) + "\n");
}

const child = spawn(bin, ["mcp"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });

let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log({ dir: "recv-nonjson", raw: trimmed, at: Date.now() });
    return;
  }
  log({ dir: "recv", msg, at: Date.now() });
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

child.on("exit", (code, signal) => {
  log({ dir: "exit", code, signal, at: Date.now() });
});
child.on("error", (err) => {
  log({ dir: "spawn-error", message: String(err), at: Date.now() });
});

function send(method, params, { expectReply = true } = {}) {
  const msg = { jsonrpc: "2.0", method, params };
  if (expectReply) msg.id = nextId++;
  log({ dir: "send", msg, at: Date.now() });
  child.stdin.write(JSON.stringify(msg) + "\n");
  if (!expectReply) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(msg.id)) {
        pending.delete(msg.id);
        reject(new Error(`timeout waiting for response to ${method} (id=${msg.id})`));
      }
    }, 30000);
  });
}

async function main() {
  const results = {};

  results.initialize = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "pi-sentrux-phase0-driver", version: "0.0.0" },
  });

  await send("notifications/initialized", {}, { expectReply: false });

  results.toolsList = await send("tools/list", {});

  results.scanAbsolute = await send("tools/call", { name: "scan", arguments: { path: root } });
  results.health1 = await send("tools/call", { name: "health", arguments: {} });

  // session_end BEFORE any session_start
  results.sessionEndBeforeStart = await send("tools/call", { name: "session_end", arguments: {} });

  results.sessionStart = await send("tools/call", { name: "session_start", arguments: {} });
  results.sessionEnd1 = await send("tools/call", { name: "session_end", arguments: {} });
  results.sessionEnd2 = await send("tools/call", { name: "session_end", arguments: {} }); // repeat, no new session_start

  results.scanRelative = await send("tools/call", { name: "scan", arguments: { path: "." } });

  results.dsmStats = await send("tools/call", { name: "dsm", arguments: {} });
  results.dsmText = await send("tools/call", { name: "dsm", arguments: { format: "text" } });

  results.testGaps = await send("tools/call", { name: "test_gaps", arguments: {} });
  results.testGapsLimit = await send("tools/call", { name: "test_gaps", arguments: { limit: 1 } });

  results.gitStats = await send("tools/call", { name: "git_stats", arguments: {} });
  results.gitStatsDays = await send("tools/call", { name: "git_stats", arguments: { days: 7 } });

  // this root's rules.toml has 5 ACTIVE constraint rules (see
  // test/fixtures/v0.5.7/check/many-rules-fail/rules.toml) -> tests the
  // "capped at 3 in free tier" MCP claim.
  results.checkRules = await send("tools/call", { name: "check_rules", arguments: {} });

  results.rescan = await send("tools/call", { name: "rescan", arguments: {} });

  results.unknownTool = await send("tools/call", { name: "bogus_tool_xyz", arguments: {} });

  results.ping = await send("ping", {});

  results.unknownMethod = await send("totally/unknown/method", {});

  log({ dir: "summary", results, at: Date.now() });
  console.log(JSON.stringify(results, null, 2));

  child.stdin.end();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 5000);
    child.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });

  appendFileSync(outPath, JSON.stringify({ dir: "stderr-tail", tail: stderrBuf.slice(-4000) }) + "\n");

  if (child.exitCode === null && !child.killed) {
    console.error("process did NOT exit after stdin EOF within 5s; killing");
    child.kill("SIGKILL");
    process.exitCode = 1;
  } else {
    console.error(`process exited after stdin EOF: code=${child.exitCode} signal=${child.signalCode}`);
  }
}

main().catch((err) => {
  console.error("driver error:", err);
  log({ dir: "error", message: String((err && err.stack) || err), at: Date.now() });
  try {
    child.kill("SIGKILL");
  } catch {}
  process.exit(1);
});
