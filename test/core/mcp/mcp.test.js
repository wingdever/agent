"use strict";

// MCP tools are ordinary registry entries. These tests pin the adapter's
// model-facing contract — naming, schema passthrough, content projection, error
// shape — and the rule that the public name never reaches tools/call. Protocol
// work lives in the SDK; what is asserted here is our adaptation of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { McpServerConnection, projectContent, loadMcpTools } from "../../../core/mcp/index.js";
import { buildResourceTools, renderResourceResult } from "../../../core/mcp/resources.js";
import { validateSchema } from "../../../core/tools/schema.js";

function haveServer() {
  try {
    execFileSync("which", ["mcp-server-memory"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

const skip = haveServer() ? false : "mcp-server-memory is not installed";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

function memoryConnection(overrides = {}) {
  return new McpServerConnection(
    {
      name: "reference_memory",
      command: "mcp-server-memory",
      args: [],
      env: { MEMORY_FILE_PATH: path.join(tempDir("mcp-memory-"), "graph.jsonl") },
      cwd: process.cwd(),
      timeoutMs: 20000,
      reconnect: 0,
      transport: "stdio",
      ...overrides,
    },
    { logger: quietLogger(), onToolsChanged: () => {}, onResourcesChanged: () => {} },
  );
}

async function withMemoryConnection(fn) {
  const connection = memoryConnection();
  assert.equal(await connection.start(), true);
  try {
    await fn(connection);
  } finally {
    connection.close();
  }
}

test("connection discovers tools and calls round-trip through the raw name", { skip }, async () => {
  await withMemoryConnection(async (connection) => {
    const names = [...connection.tools.keys()];
    assert.ok(names.includes("mcp__reference_memory__create_entities"));
    assert.ok(names.includes("mcp__reference_memory__search_nodes"));

    const created = await connection.tools.get("mcp__reference_memory__create_entities").run({
      entities: [{ name: "mcp-probe", entityType: "test", observations: ["drink=oolong"] }],
    });
    assert.notEqual(created.isError, true);

    const found = await connection.tools.get("mcp__reference_memory__search_nodes").run({ query: "oolong" });
    assert.match(found, /mcp-probe/);
  });
});

test("server schemas validate like built-ins under the shared validator", { skip }, async () => {
  await withMemoryConnection(async (connection) => {
    const search = connection.tools.get("mcp__reference_memory__search_nodes");
    assert.deepEqual(validateSchema(search.parameters, {}), ['missing required property "query"']);
    assert.deepEqual(validateSchema(search.parameters, { query: "x" }), []);
  });
});

test("tools/call receives the raw name, and isError survives projection", async () => {
  const script = path.join(tempDir("mcp-stub-"), "server.mjs");
  fs.writeFileSync(
    script,
    `import readline from "readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") return;
  let result;
  if (msg.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } };
  } else if (msg.method === "tools/list") {
    result = { tools: [
      { name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "boom", description: "always fails", inputSchema: { type: "object", properties: {} } },
    ] };
  } else if (msg.method === "tools/call") {
    process.stderr.write("CALLED:" + msg.params.name + "\\n");
    result = msg.params.name === "boom"
      ? { isError: true, content: [{ type: "text", text: "server said no" }] }
      : { content: [{ type: "text", text: "echo:" + msg.params.arguments.text }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`,
  );

  const called = [];
  const logger = {
    log() {},
    warn(line) {
      const match = /CALLED:(.*)$/.exec(line);
      if (match) called.push(match[1].trim());
    },
    error() {},
  };
  const connection = new McpServerConnection(
    {
      name: "stub",
      command: process.execPath,
      args: [script],
      env: {},
      cwd: process.cwd(),
      timeoutMs: 20000,
      reconnect: 0,
      transport: "stdio",
    },
    { logger, onToolsChanged: () => {}, onResourcesChanged: () => {} },
  );

  try {
    assert.equal(await connection.start(), true);
    const names = [...connection.tools.keys()].sort();
    assert.deepEqual(names, ["mcp__stub__boom", "mcp__stub__echo"]);

    // Public name is mcp__stub__echo; tools/call must still carry "echo".
    const echoed = await connection.tools.get("mcp__stub__echo").run({ text: "hi" });
    assert.equal(echoed, "echo:hi");

    const projected = await connection.tools.get("mcp__stub__boom").run({});
    assert.equal(projected.isError, true);
    assert.equal(projected.text, "server said no");
  } finally {
    connection.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(called, ["echo", "boom"]);
});

test("projectContent joins text blocks, diagnoses others, and preserves isError", () => {
  assert.equal(
    projectContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    "a\nb",
  );
  assert.match(
    projectContent({ content: [{ type: "image", data: "..." }] }),
    /unsupported MCP content: image/,
  );
  const failure = projectContent({ isError: true, content: [{ type: "text", text: "denied" }] });
  assert.deepEqual(failure, { text: "denied", isError: true });
  const empty = projectContent({ isError: true });
  assert.equal(empty.isError, true);
  assert.ok(empty.text.length > 0);
});

test("renderResourceResult attributes the server and describes binary payloads", () => {
  const { text } = renderResourceResult("memory", {
    contents: [{ uri: "memory://x", mimeType: "application/octet-stream", blob: "AAAA" }],
  });
  assert.match(text, /^MCP server: memory\n/);
  assert.match(text, /binary resource: 4 base64 characters/);
  assert.doesNotMatch(text, /"AAAA"/);
});

test("resource tools resolve a live server and reject an unknown one before any request", async () => {
  const calls = [];
  const fake = {
    listResources: async (options) => {
      calls.push(["resources/list", options]);
      return { resources: [{ uri: "memory://x", name: "x" }] };
    },
    listResourceTemplates: async (options) => {
      calls.push(["resources/templates/list", options]);
      return { resourceTemplates: [] };
    },
    readResource: async (uri) => {
      calls.push(["resources/read", uri]);
      return { contents: [{ uri, text: "hello" }] };
    },
  };
  const providers = new Map([["memory", fake]]);
  const tools = buildResourceTools(() => providers);

  const listed = await tools.list_mcp_resources.run({ server: "memory" });
  assert.match(listed.text, /MCP server: memory/);
  assert.match(listed.text, /memory:\/\/x/);

  await tools.list_mcp_resource_templates.run({ server: "memory", cursor: "c1" });
  assert.deepEqual(calls[1], ["resources/templates/list", { cursor: "c1" }]);

  const read = await tools.read_mcp_resource.run({ server: "memory", uri: "memory://x" });
  assert.match(read.text, /hello/);

  // An unknown server fails with the known names and never reaches the network.
  const before = calls.length;
  await assert.rejects(tools.read_mcp_resource.run({ server: "nope", uri: "memory://x" }), /unknown MCP resource server "nope" \(known: memory\)/);
  assert.equal(calls.length, before);

  await assert.rejects(tools.read_mcp_resource.run({ server: "memory", uri: "  " }), /uri must be a non-empty string/);

  // A server that disappears between calls is reported, not silently served.
  providers.clear();
  await assert.rejects(tools.list_mcp_resources.run({ server: "memory" }), /unknown MCP resource server "memory" \(known: none\)/);
});

test("resource tools are registered only while a resource-capable server exists", { skip }, async () => {
  const mcp = await loadMcpTools({ logger: quietLogger() });
  try {
    const names = [...mcp.tools.keys()];
    const resourceTools = names.filter((name) => !name.startsWith("mcp__") && name.includes("mcp_resource"));
    const resourceServers = mcp.resourceServerNames();
    if (resourceServers.length === 0) {
      assert.deepEqual(resourceTools, [], "no resource server means no resource tools");
      return;
    }
    assert.deepEqual(resourceTools.sort(), [
      "list_mcp_resource_templates",
      "list_mcp_resources",
      "read_mcp_resource",
    ]);

    // The memory server exposes one resource; reading it must round-trip.
    const read = await mcp.tools.get("read_mcp_resource").run({
      server: resourceServers[0],
      uri: "memory://knowledge-graph",
    });
    assert.match(read.text, /MCP server: /);
    assert.match(read.text, /knowledge-graph/);
  } finally {
    mcp.close();
  }
});
