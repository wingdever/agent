"use strict";

// Progress reporting from an MCP server. These tests need a server that emits
// progress, so each one writes a stub that sends notifications/progress while a
// tool call is outstanding. What is pinned: progress keeps a slow call alive,
// the total cap still ends a chattering server, and a caller cancel wins.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { McpServerConnection } from "../../../core/mcp/index.js";
import { DEFAULT_MAX_TOTAL_BUDGETS } from "../../../core/mcp/config.js";
import { runTool } from "../../../core/tools/executor.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function quietLogger(sink = []) {
  return {
    log: (message) => sink.push(message),
    warn: (message) => sink.push(message),
    error: (message) => sink.push(message),
  };
}

// A server whose `slow` tool answers only after `total` progress notices, one
// every `intervalMs`. If the request is not kept alive by progress, the client
// times out first. `forever` keeps reporting and never answers.
function writeProgressServer(dir, { total, intervalMs, forever = false }) {
  const script = path.join(dir, "server.mjs");
  fs.writeFileSync(
    script,
    `import readline from "readline";
const TOTAL = ${total};
const INTERVAL = ${intervalMs};
const FOREVER = ${forever};
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "progress", version: "0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "slow", description: "reports progress then answers", inputSchema: { type: "object", properties: {} } }] } });
  } else if (msg.method === "tools/call") {
    const token = msg.params._meta && msg.params._meta.progressToken;
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      if (token !== undefined) {
        send({ jsonrpc: "2.0", method: "notifications/progress",
          params: { progressToken: token, progress: sent, total: FOREVER ? undefined : TOTAL, message: "step " + sent } });
      }
      if (!FOREVER && sent >= TOTAL) {
        clearInterval(timer);
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "finished after " + sent }] } });
      }
    }, INTERVAL);
  }
});
`,
  );
  return script;
}

function connection(dir, script, overrides = {}) {
  return new McpServerConnection(
    {
      name: "progress",
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: {},
      cwd: dir,
      timeoutMs: 300,
      maxTotalMs: 300 * DEFAULT_MAX_TOTAL_BUDGETS,
      reconnect: 0,
      ...overrides,
    },
    { logger: quietLogger(), onToolsChanged: () => {}, onResourcesChanged: () => {} },
  );
}

test("progress keeps a slow call alive past the per-request budget", async () => {
  const dir = tempDir("mcp-progress-");
  // 6 notices every 100ms = ~600ms, well past the 300ms per-request budget.
  const script = writeProgressServer(dir, { total: 6, intervalMs: 100, forever: false });
  const conn = connection(dir, script);
  try {
    assert.equal(await conn.start(), true);
    const started = Date.now();
    const result = await conn.tools.get("mcp__progress__slow").run({});
    const elapsed = Date.now() - started;
    assert.equal(result, "finished after 6", "the call completed instead of timing out");
    assert.ok(elapsed > 300, `call finished before the budget could matter: ${elapsed}ms`);
  } finally {
    conn.close();
  }
});

test("progress notices are surfaced to the logger, not to the model", async () => {
  const dir = tempDir("mcp-progress-log-");
  const script = writeProgressServer(dir, { total: 3, intervalMs: 60, forever: false });
  const sink = [];
  const conn = new McpServerConnection(
    {
      name: "progress",
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: {},
      cwd: dir,
      timeoutMs: 300,
      maxTotalMs: 3000,
      reconnect: 0,
    },
    { logger: quietLogger(sink), onToolsChanged: () => {}, onResourcesChanged: () => {} },
  );
  try {
    assert.equal(await conn.start(), true);
    const text = await conn.tools.get("mcp__progress__slow").run({});
    assert.equal(text, "finished after 3");
    const progressLines = sink.filter((line) => / progress /.test(line));
    assert.ok(progressLines.length >= 3, `expected progress log lines, saw ${JSON.stringify(sink)}`);
    assert.match(progressLines[0], /progress 1\/3 step 1/);
    // The model sees only the tool result.
    assert.doesNotMatch(text, /progress/i);
  } finally {
    conn.close();
  }
});

test("a chattering server still ends at the total cap", async () => {
  const dir = tempDir("mcp-progress-cap-");
  // Reports forever; only the total cap can end it. 300ms * 3 = 900ms cap.
  const script = writeProgressServer(dir, { total: 0, intervalMs: 50, forever: true });
  const conn = connection(dir, script, { timeoutMs: 300, maxTotalMs: 900 });
  try {
    assert.equal(await conn.start(), true);
    const started = Date.now();
    await assert.rejects(
      conn.tools.get("mcp__progress__slow").run({}),
      /Maximum total timeout exceeded|timed out/i,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 800, `ended before the total cap: ${elapsed}ms`);
    assert.ok(elapsed < 5000, `the cap did not apply: ${elapsed}ms`);
  } finally {
    conn.close();
  }
});

test("a caller cancel beats both budgets, even while progress flows", async () => {
  const dir = tempDir("mcp-progress-cancel-");
  const script = writeProgressServer(dir, { total: 0, intervalMs: 50, forever: true });
  const conn = connection(dir, script, { timeoutMs: 30000, maxTotalMs: 300000 });
  try {
    assert.equal(await conn.start(), true);
    const controller = new AbortController();
    const started = Date.now();
    const pending = runTool(conn.tools.get("mcp__progress__slow"), {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.text, "Error: tool call aborted");
    assert.ok(Date.now() - started < 5000);
  } finally {
    conn.close();
  }
});

test("a server that reports no progress keeps the plain per-request budget", async () => {
  const dir = tempDir("mcp-progress-none-");
  const script = writeProgressServer(dir, { total: 0, intervalMs: 100000, forever: false });
  const conn = connection(dir, script, { timeoutMs: 300 });
  try {
    assert.equal(await conn.start(), true);
    const started = Date.now();
    await assert.rejects(conn.tools.get("mcp__progress__slow").run({}), /timed out|RequestTimeout/i);
    const elapsed = Date.now() - started;
    // No progress means no reset: the configured 300ms budget still applies.
    assert.ok(elapsed < 5000, `unexpected delay: ${elapsed}ms`);
  } finally {
    conn.close();
  }
});

test("maxTotalMs defaults to the configured number of budgets", async () => {
  const { readServers } = await import("../../../core/mcp/config.js");
  const servers = readServers(quietLogger());
  for (const server of servers) {
    assert.equal(server.maxTotalMs, server.timeoutMs * DEFAULT_MAX_TOTAL_BUDGETS);
  }
  assert.equal(DEFAULT_MAX_TOTAL_BUDGETS, 10);
});
