"use strict";

// Streamable HTTP transport, end to end over a real HTTP server. The server side
// is the official SDK's, so what these tests pin is our wiring: URL/header config,
// tool discovery and calls over HTTP, and the same reconnect semantics the stdio
// path has.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { McpServerConnection } from "../../../core/mcp/index.js";

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

// One stateless MCP endpoint per request, which keeps the fixture free of
// session bookkeeping. It records the authorization header it observed so the
// header plumbing can be asserted.
async function startHttpServer({ requireAuth = null } = {}) {
  const seen = [];
  // A stateless endpoint builds a fresh server and transport per request. That
  // is the SDK's documented shape for sessionIdGenerator: undefined, and it
  // keeps this fixture free of session bookkeeping.
  function buildServer() {
    const mcp = new McpServer({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.registerTool(
      "ping",
      { description: "Replies pong.", inputSchema: { text: z.string().optional() } },
      async ({ text }) => ({ content: [{ type: "text", text: "pong" + (text ? ":" + text : "") }] }),
    );
    return mcp;
  }

  const server = createServer(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (requireAuth && req.headers.authorization !== requireAuth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
      return;
    }
    try {
      const mcp = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: async () => new Promise((resolve) => server.close(resolve)),
  };
}

function httpConnection(url, overrides = {}) {
  return new McpServerConnection(
    {
      name: "remote",
      transport: "streamable-http",
      url,
      headers: {},
      timeoutMs: 15000,
      reconnect: 0,
      ...overrides,
    },
    { logger: quietLogger(), onToolsChanged: () => {}, onResourcesChanged: () => {} },
  );
}

test("streamable-http discovers tools and calls them over the wire", async () => {
  const fixture = await startHttpServer();
  const connection = httpConnection(fixture.url);
  try {
    assert.equal(await connection.start(), true);
    assert.ok(connection.tools.has("mcp__remote__ping"));

    const text = await connection.tools.get("mcp__remote__ping").run({ text: "hi" });
    assert.equal(text, "pong:hi");
    assert.ok(fixture.seen.length > 0, "the endpoint was reached over HTTP");
  } finally {
    connection.close();
    await fixture.close();
  }
});

test("configured headers reach the server", async () => {
  const fixture = await startHttpServer({ requireAuth: "Bearer secret-token" });
  const connection = httpConnection(fixture.url, {
    headers: { Authorization: "Bearer secret-token" },
  });
  try {
    assert.equal(await connection.start(), true);
    const text = await connection.tools.get("mcp__remote__ping").run({});
    assert.equal(text, "pong");
    assert.ok(fixture.seen.some((request) => request.authorization === "Bearer secret-token"));
  } finally {
    connection.close();
    await fixture.close();
  }
});

test("an unreachable endpoint is skipped instead of aborting startup", async () => {
  // Port 1 is reserved and never served.
  const connection = httpConnection("http://127.0.0.1:1/mcp");
  try {
    assert.equal(await connection.start(), false);
    assert.equal(connection.tools.size, 0);
  } finally {
    connection.close();
  }
});

test("the SDK client accepts the endpoint independent of our connection layer", async () => {
  // Guards the assumption that a reconnecting connection and a fresh client
  // speak the same protocol: a bare SDK client must reach the same fixture.
  const fixture = await startHttpServer();
  const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  try {
    await client.connect(new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(new URL(fixture.url)));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["ping"]);
  } finally {
    await client.close();
    await fixture.close();
  }
});
