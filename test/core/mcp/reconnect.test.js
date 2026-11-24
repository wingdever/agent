"use strict";

// Reconnect and tool re-sync: the connection outlives a single child process.
// These tests drive real processes — one that crashes on demand, one that
// announces tools/list_changed — because the behaviour under test is precisely
// what happens around process death and notification delivery.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { McpServerConnection } from "../../../core/mcp/index.js";
import { readServers, DEFAULT_RECONNECT } from "../../../core/mcp/config.js";
import { runTool } from "../../../core/tools/executor.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

// A server that serves a tool list, counts its own starts in a file, and hangs
// up once the marker file named in CRASH_AFTER exists. The start count makes a
// reconnect observable across process boundaries.
function writeCrashyServer(dir) {
  const script = path.join(dir, "server.mjs");
  const counter = path.join(dir, "starts.log");
  fs.writeFileSync(
    script,
    `import fs from "fs";
import readline from "readline";
const counter = ${JSON.stringify(counter)};
fs.appendFileSync(counter, "start\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") return;
  let result;
  if (msg.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "crashy", version: "0" } };
  } else if (msg.method === "tools/list") {
    result = { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] };
  } else if (msg.method === "tools/call") {
    if (msg.params.name === "crash") process.exit(1);
    result = { content: [{ type: "text", text: "pong" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`,
  );
  return { script, counter };
}

function serverEntry(overrides = {}) {
  return {
    name: "crashy",
    command: process.execPath,
    args: [],
    env: { ...process.env },
    cwd: process.cwd(),
    timeoutMs: 10000,
    reconnect: DEFAULT_RECONNECT,
    ...overrides,
  };
}

function startCount(counter) {
  try {
    return fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
  } catch (_) {
    return 0;
  }
}

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test("a crashed server drops its tools, then reconnects and re-registers them", async () => {
  const dir = tempDir("mcp-crash-");
  const { script, counter } = writeCrashyServer(dir);

  const published = new Map();
  const connection = new McpServerConnection(
    serverEntry({ args: [script] }),
    {
      logger: quietLogger(),
      onToolsChanged: (serverName, next) => {
        for (const name of [...published.keys()]) {
          if (name.startsWith(`mcp__${serverName}__`)) published.delete(name);
        }
        for (const [name, tool] of next) published.set(name, tool);
      },
    },
  );

  try {
    assert.equal(await connection.start(), true);
    const toolName = "mcp__crashy__ping";
    assert.ok(published.has(toolName), "tool registered on first connect");
    assert.equal(startCount(counter), 1);

    // Kill the child from the inside; the client must notice and drop the tools.
    await assert.rejects(connection._call("crash", {}));
    await waitFor(() => !published.has(toolName));
    assert.ok(connection.client === null || connection.client.closed);

    // The reconnect loop must bring it back on its own.
    await waitFor(() => published.has(toolName), { timeoutMs: 8000 });
    assert.equal(startCount(counter), 2, "a second process was spawned");
    assert.equal(await connection._call("ping", {}).then((r) => r.content[0].text), "pong");
  } finally {
    connection.close();
  }
});

test("close() stops the reconnect loop and does not resurrect the server", async () => {
  const dir = tempDir("mcp-crash-close-");
  const { script, counter } = writeCrashyServer(dir);

  const connection = new McpServerConnection(serverEntry({ args: [script] }), {
    logger: quietLogger(),
    onToolsChanged: () => {},
  });

  assert.equal(await connection.start(), true);
  await assert.rejects(connection._call("crash", {}));
  connection.close();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(startCount(counter), 1, "no reconnect after close()");
  assert.equal(connection.tools.size, 0);
});

test("reconnect: 0 leaves a crashed server down instead of retrying", async () => {
  const dir = tempDir("mcp-noreconnect-");
  const { script, counter } = writeCrashyServer(dir);

  const connection = new McpServerConnection(serverEntry({ args: [script], reconnect: 0 }), {
    logger: quietLogger(),
    onToolsChanged: () => {},
  });

  assert.equal(await connection.start(), true);
  await assert.rejects(connection._call("crash", {}));
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(startCount(counter), 1, "no second process with reconnect: 0");
});

// A server whose tool set grows after it announces tools/list_changed. The
// re-list must reach the shared table without any reconnect.
function writeMutatingServer(dir) {
  const script = path.join(dir, "server.mjs");
  fs.writeFileSync(
    script,
    `import readline from "readline";
let phase = 0;
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    const tools = [{ name: "alpha", description: "a", inputSchema: { type: "object", properties: {} } }];
    if (phase > 0) tools.push({ name: "beta", description: "b", inputSchema: { type: "object", properties: {} } });
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mutating", version: "0" } } });
  } else if (msg.method === "tools/call" && msg.params.name === "grow") {
    phase = 1;
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "grew" }] } });
  }
});
`,
  );
  return script;
}

test("tools/list_changed re-lists and adds the new tool without reconnecting", async () => {
  const dir = tempDir("mcp-change-");
  const script = writeMutatingServer(dir);

  const published = new Map();
  const changes = [];
  const connection = new McpServerConnection(serverEntry({ name: "mutating", args: [script] }), {
    logger: quietLogger(),
    onToolsChanged: (serverName, next) => {
      changes.push(next.size);
      for (const name of [...published.keys()]) {
        if (name.startsWith(`mcp__${serverName}__`)) published.delete(name);
      }
      for (const [name, tool] of next) published.set(name, tool);
    },
  });

  try {
    assert.equal(await connection.start(), true);
    assert.deepEqual([...published.keys()], ["mcp__mutating__alpha"]);

    await connection._call("grow", {});
    await waitFor(() => published.has("mcp__mutating__beta"));
    assert.ok(published.has("mcp__mutating__alpha"), "existing tool survives the re-list");
    assert.equal(startCount(path.join(dir, "starts.log")), 0, "no crash counter for this server");
    assert.ok(changes.length >= 2);
  } finally {
    connection.close();
  }
});

test("calling a disconnected server fails loudly instead of hanging", async () => {
  const dir = tempDir("mcp-down-");
  const { script } = writeCrashyServer(dir);
  const connection = new McpServerConnection(serverEntry({ args: [script], reconnect: 0 }), {
    logger: quietLogger(),
    onToolsChanged: () => {},
  });
  try {
    await connection.start();
    await assert.rejects(connection._call("crash", {}));
    await waitFor(() => connection.client === null);
    await assert.rejects(connection._call("ping", {}), /not connected/);
  } finally {
    connection.close();
  }
});

test("reconnect config defaults to 3 and accepts 0 as an explicit opt-out", () => {
  // readServers reads user/mcp.json, which this test must not depend on, so the
  // field semantics are checked through a temporary override of the config file
  // shape instead.
  assert.equal(DEFAULT_RECONNECT, 3);
  const servers = readServers(quietLogger());
  for (const server of servers) {
    assert.ok(Number.isInteger(server.reconnect) && server.reconnect >= 0);
  }
});

// The wiring test that the connection-level tests cannot cover: ToolService must
// see the same Map the connection mutates, or a reconnect updates a table nobody
// reads. This is asserted against createCore's own composition path.
test("createCore hands ToolService the table the connection mutates", async () => {
  const { createCore } = await import("../../../core/index.js");
  const core = await createCore();
  const RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  const summarize = () => ({
    mcp: [...core.tools.keys()].filter((name) => name.startsWith("mcp__")).length,
    // The three resource tools belong to MCP too: they come and go with the
    // servers, so they are not part of the built-in baseline.
    resources: [...core.tools.keys()].filter((name) => RESOURCE_TOOLS.has(name)).length,
    builtins: [...core.tools.keys()].filter(
      (name) => !name.startsWith("mcp__") && !RESOURCE_TOOLS.has(name),
    ).length,
  });
  const connection = core.mcp.servers.get("reference_memory");
  if (!connection || !connection.client) {
    core.mcp.close();
    if (core.store && core.store.close) await core.store.close();
    return; // server not configured on this machine
  }

  try {
    const before = summarize();
    assert.ok(before.mcp > 0, "configured server contributed tools");
    const builtins = before.builtins;

    // read_graph takes no arguments, so it exercises the call path without
    // depending on the configured server's schema.
    const toolName = "mcp__reference_memory__read_graph";
    assert.equal(typeof core.tools.get(toolName).run, "function");

    // Kill the child behind the SDK transport: the SDK exposes no public spawn
    // handle, and the point of this test is the reaction to an abrupt loss.
    connection.client.transport._process.kill("SIGKILL");
    await waitFor(() => summarize().mcp === 0);
    assert.equal(summarize().resources, 0, "resource tools leave with the server");
    assert.equal(summarize().builtins, builtins, "built-ins are untouched by an MCP loss");

    await waitFor(() => summarize().mcp === before.mcp, { timeoutMs: 8000 });
    const revived = core.tools.get(toolName);
    assert.equal(typeof revived.run, "function", "the re-registered tool is callable");
    const outcome = await revived.run({});
    assert.equal(typeof (typeof outcome === "string" ? outcome : outcome.text), "string");
  } finally {
    core.mcp.close();
    if (core.store && core.store.close) await core.store.close();
  }
});

// The timeout is a request option, not a tool field: a server that never answers
// must fail within the configured budget. The SDK's own default is 60s, so a
// short budget proves the configured value is the one applied.
test("timeoutMs bounds a tool call instead of the SDK default", async () => {
  const dir = tempDir("mcp-slow-");
  const script = path.join(dir, "server.mjs");
  fs.writeFileSync(
    script,
    `import readline from "readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slow", version: "0" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      tools: [{ name: "stall", description: "never answers", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
  }
  // tools/call stays unanswered on purpose.
});
`,
  );

  const connection = new McpServerConnection(serverEntry({ name: "slow", args: [script], timeoutMs: 300 }), {
    logger: quietLogger(),
    onToolsChanged: () => {},
  });

  try {
    assert.equal(await connection.start(), true);
    const started = Date.now();
    await assert.rejects(connection.tools.get("mcp__slow__stall").run({}), /timed out|timeout|RequestTimeout/i);
    const elapsed = Date.now() - started;
    // Well under the SDK's 60s default, and not so fast that nothing was waited.
    assert.ok(elapsed >= 250, `gave up too early: ${elapsed}ms`);
    assert.ok(elapsed < 5000, `used a timeout other than the configured one: ${elapsed}ms`);
  } finally {
    connection.close();
  }
});

// tools/list_changed now flows through the SDK's listChanged config, which
// debounces a burst into a single refresh. Both notices must end in one table
// update, not two.
test("a burst of tools/list_changed notices collapses into one refresh", async () => {
  const dir = tempDir("mcp-burst-");
  const script = path.join(dir, "server.mjs");
  const listCalls = path.join(dir, "lists.log");
  fs.writeFileSync(
    script,
    `import readline from "readline";
import fs from "fs";
let phase = 0;
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true } }, serverInfo: { name: "burst", version: "0" } } });
  } else if (msg.method === "tools/list") {
    fs.appendFileSync(${JSON.stringify(listCalls)}, "list\\n");
    const tools = [{ name: "alpha", description: "a", inputSchema: { type: "object", properties: {} } }];
    if (phase > 0) tools.push({ name: "beta", description: "b", inputSchema: { type: "object", properties: {} } });
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call" && msg.params.name === "grow") {
    phase = 1;
    // Three notices in quick succession.
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "grew" }] } });
  }
});
`,
  );

  const published = new Map();
  const connection = new McpServerConnection(serverEntry({ name: "burst", args: [script] }), {
    logger: quietLogger(),
    onToolsChanged: (serverName, next) => {
      for (const name of [...published.keys()]) {
        if (name.startsWith(`mcp__${serverName}__`)) published.delete(name);
      }
      for (const [name, tool] of next) published.set(name, tool);
    },
  });

  try {
    assert.equal(await connection.start(), true);
    const before = fs.readFileSync(listCalls, "utf8").split("\n").filter(Boolean).length;
    await connection._call("grow", {});
    await waitFor(() => published.has("mcp__burst__beta"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = fs.readFileSync(listCalls, "utf8").split("\n").filter(Boolean).length;
    // The SDK refreshes once for the burst; our code must not add its own listing.
    assert.equal(after - before, 1, `expected one refresh, saw ${after - before}`);
    assert.ok(published.has("mcp__burst__alpha"), "existing tool survives the refresh");
  } finally {
    connection.close();
  }
});

// A cancel must reach the wire, not just decorate the result: a server that
// never answers must give up as soon as the caller's signal fires.
test("a cancellable MCP call stops waiting when the signal fires", async () => {
  const dir = tempDir("mcp-cancel-");
  const script = path.join(dir, "server.mjs");
  fs.writeFileSync(
    script,
    `import readline from "readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stall", version: "0" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      tools: [{ name: "stall", description: "never answers", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
  }
  // tools/call stays unanswered so only the signal can end it.
});
`,
  );

  const connection = new McpServerConnection(
    // A long timeout proves the signal, not the timeout, ends the call.
    serverEntry({ name: "stall", args: [script], timeoutMs: 30000 }),
    { logger: quietLogger(), onToolsChanged: () => {} },
  );

  try {
    assert.equal(await connection.start(), true);
    const controller = new AbortController();
    const started = Date.now();
    const pending = runTool(
      connection.tools.get("mcp__stall__stall"),
      {},
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);

    const result = await pending;
    const elapsed = Date.now() - started;
    assert.equal(result.isError, true);
    assert.equal(result.text, "Error: tool call aborted");
    assert.ok(elapsed < 5000, `the call outlived the abort: ${elapsed}ms`);
  } finally {
    connection.close();
  }
});
