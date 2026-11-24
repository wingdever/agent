"use strict";

// Load MCP servers from user/mcp.json and adapt discovered tools into the
// same shape the directory tool registry produces, so ToolService, the
// permission gate and the loop engines need no MCP-specific branch.
//
// Each server is owned by an McpServerConnection, which keeps the live tool
// table in sync with its connection: a crash triggers a reconnect, and a
// tools/list_changed notification re-lists. The shared Map handed to
// ToolService is mutated in place, so the next turn picks up the new set
// without rebuilding the service.
//
// Protocol work (handshake, pagination, SSE, session ids) belongs to the
// official SDK client; this module owns only lifecycle and adaptation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readServers } from "./config.js";
import { createTransport } from "./transport.js";
import { buildResourceTools } from "./resources.js";

const EMPTY_SCHEMA = { type: "object", properties: {}, required: [] };
const DEFAULT_RECONNECT = 3;
const DEFAULT_RECONNECT_DELAY_MS = 1000;

// MCP content blocks collapse to the single text channel this project's tools
// speak. Error results stay errors instead of being dressed up as success.
function projectContent(result) {
  const blocks = result && Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block && typeof block === "object") {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else parts.push(`[unsupported MCP content: ${block.type || "unknown"}]`);
    } else if (typeof block === "string") {
      parts.push(block);
    }
  }
  const text = parts.join("\n");
  if (result && result.isError === true) {
    return { text: text || "MCP tool reported an error", isError: true };
  }
  return text;
}

// `call(rawName, args)` is the connection's dispatch; taking it explicitly keeps
// the closure bound to the owning connection, so a reconnect (which swaps the
// client, not the connection) never leaves a stale reference behind.
function normalizeTools(server, listed, call) {
  const tools = new Map();
  for (const tool of listed) {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim()) continue;
    const name = `mcp__${server.name}__${tool.name}`;
    if (tools.has(name)) continue;
    tools.set(name, {
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : EMPTY_SCHEMA,
      // 服务器暴露的工具可以产生任意副作用，按最保守的 write 处理；分组交给 UI 的 MCP 子标签。
      mode: "write",
      group: "mcp",
      prompt: "",
      promptSection: "",
      timeoutMs: server.timeoutMs,
      defaultVisible: true,
      result: "text",
      // The public name only exists for the model and permission rules;
      // tools/call always sends the raw name the server declared.
      run: async (args, exec) => projectContent(await call(tool.name, args, exec && exec.signal)),
    });
  }
  return tools;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One configured server and the connection currently backing it. The connection
// outlives any single client: reconnect replaces the client and re-registers
// whatever the new process declares.
class McpServerConnection {
  constructor(server, { logger, onToolsChanged, onResourcesChanged }) {
    this.server = server;
    this.logger = logger;
    this.onToolsChanged = onToolsChanged || (() => {});
    this.onResourcesChanged = onResourcesChanged || (() => {});
    // Maps swapped into the shared tables on every successful (re)connect or
    // re-list.
    this.tools = new Map();
    this.client = null;
    this.serverCapabilities = {};
    this.serverInfo = null;
    this.instructions = "";
    this.closed = false;
    this._reconnectTimer = null;
    // Bumped for every client this connection builds; a close callback carrying
    // a stale generation is ignored.
    this._generation = 0;
  }

  // Whether this server can serve resource calls at all. Read from the live
  // handshake, so a server that loses the capability stops advertising it.
  get hasResources() {
    return Boolean(this.client && this.serverCapabilities && this.serverCapabilities.resources);
  }

  // Retry only the initial handshake: a spawn failure is often transient (slow
  // disk, service not up yet). Later drops go through _scheduleReconnect.
  async start() {
    const reconnect = this.server.reconnect;
    let attempt = 0;
    for (;;) {
      try {
        await this._open();
        if (attempt > 0) this._log("log", `[mcp] server "${this.server.name}" connected after retry`);
        return true;
      } catch (error) {
        attempt += 1;
        if (this.closed || attempt > reconnect) {
          this._log("error", `[mcp] server "${this.server.name}" skipped: ${error.message}`);
          return false;
        }
        this._log("warn", `[mcp] server "${this.server.name}" connect attempt ${attempt} failed: ${error.message}`);
        await delay(DEFAULT_RECONNECT_DELAY_MS * attempt);
      }
    }
  }

  async _open() {
    const generation = ++this._generation;
    const transport = createTransport(this.server, this.logger);
    const client = new Client(
      { name: "agent", version: "0.1.0" },
      {
        capabilities: {},
        // The SDK subscribes only when the server advertises tools.listChanged,
        // debounces a burst of notices into one refresh, and hands us the
        // already-fetched list (autoRefresh). We re-register from that list
        // instead of issuing a second tools/list.
        listChanged: {
          tools: {
            onChanged: (error, tools) => this._onToolsChanged(generation, client, error, tools),
          },
        },
      },
    );

    // The SDK reports transport loss through onclose. A deliberate close() sets
    // `closed` first so a shutdown is never mistaken for a crash, and a callback
    // from a superseded client must not tear down the live one.
    client.onclose = () => {
      if (this.closed || generation !== this._generation || client !== this.client) return;
      this._onUnexpectedClose(new Error(`MCP server "${this.server.name}" connection closed`));
    };
    client.onerror = (error) => this._log("warn", `[mcp:${this.server.name}] ${error.message}`);

    await client.connect(transport);
    const listed = await client.listTools({}, { timeout: this.server.timeoutMs });
    this.client = client;
    this.serverCapabilities = client.getServerCapabilities() || {};
    this.serverInfo = client.getServerVersion() || null;
    this.instructions = client.getInstructions() || "";
    this._applyTools(normalizeTools(this.server, listed.tools || [], (name, args, signal) => this._call(name, args, signal)));
    this.onResourcesChanged(this.server.name, this.hasResources);
    return client;
  }

  _applyTools(next) {
    this.tools = next;
    this.onToolsChanged(this.server.name, next);
  }

  // tools/list_changed: the connection is alive, only its tool set changed, so
  // no reconnect is needed. The SDK has already listed (autoRefresh) and reports
  // a failure through `error` instead of throwing, so both are handled here.
  _onToolsChanged(generation, client, error, tools) {
    if (this.closed || generation !== this._generation || client !== this.client) return;
    if (error) {
      this._log("error", `[mcp] server "${this.server.name}" re-list failed: ${error.message}`);
      return;
    }
    if (!Array.isArray(tools)) return;
    this._applyTools(normalizeTools(this.server, tools, (name, args, signal) => this._call(name, args, signal)));
    this._log("log", `[mcp] server "${this.server.name}" tools re-listed: ${this.tools.size}`);
  }

  _onUnexpectedClose(error) {
    if (this.closed) return;
    this._log("warn", `[mcp] server "${this.server.name}" lost: ${error.message}`);
    // Drop the dead tools now: a tool that cannot run should not be advertised
    // to the model while the server is down.
    this._applyTools(new Map());
    this.onResourcesChanged(this.server.name, false);
    this.client = null;
    this.serverCapabilities = {};
    this.instructions = "";
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const reconnect = this.server.reconnect;
    if (reconnect <= 0) {
      this._log("error", `[mcp] server "${this.server.name}" will not reconnect (reconnect: 0)`);
      return;
    }
    let attempt = 0;
    const tryOnce = () => {
      this._reconnectTimer = null;
      if (this.closed) return;
      this._open()
        .then(() => {
          this._log("log", `[mcp] server "${this.server.name}" reconnected, ${this.tools.size} tools`);
        })
        .catch((error) => {
          attempt += 1;
          if (this.closed) return;
          if (attempt >= reconnect) {
            this._log("error", `[mcp] server "${this.server.name}" gave up after ${attempt} reconnect attempts: ${error.message}`);
            return;
          }
          this._log("warn", `[mcp] server "${this.server.name}" reconnect ${attempt}/${reconnect} failed: ${error.message}`);
          this._reconnectTimer = setTimeout(tryOnce, DEFAULT_RECONNECT_DELAY_MS * attempt);
        });
    };
    // First retry waits one base delay, so a server that crashes on startup does
    // not spin.
    this._reconnectTimer = setTimeout(tryOnce, DEFAULT_RECONNECT_DELAY_MS);
  }

  // Every request carries the configured budget. The SDK falls back to its own
  // 60s default when `timeout` is omitted, which would silently ignore the
  // user's `timeoutMs`. A caller signal, when present, cancels the request.
  //
  // A slow server that reports progress should not be killed for taking long:
  // each progress notice restarts the budget, and the total is capped at the
  // configured factor so a server that keeps chattering still ends. A server
  // that never reports progress keeps the plain per-request budget.
  _requestOptions(signal) {
    const timeout = this.server.timeoutMs;
    const options = {
      timeout,
      maxTotalTimeout: this.server.maxTotalMs,
      resetTimeoutOnProgress: true,
      onprogress: (progress) => this._onProgress(progress),
    };
    if (signal) options.signal = signal;
    return options;
  }

  // Progress is model-invisible: it exists to keep the request alive and to make
  // a stalled server diagnosable in the log.
  _onProgress(progress) {
    const total = Number.isFinite(progress && progress.total) ? `/${progress.total}` : "";
    const message = progress && progress.message ? ` ${progress.message}` : "";
    this._log("log", `[mcp] server "${this.server.name}" progress ${progress && progress.progress}${total}${message}`);
  }

  async _call(rawName, args, signal) {
    if (!this.client) throw new Error(`MCP server "${this.server.name}" is not connected`);
    return this.client.callTool(
      { name: rawName, arguments: args || {} },
      undefined,
      this._requestOptions(signal),
    );
  }

  // Resource calls resolve the live client before touching the network, so a
  // server that is down fails with a clear message instead of a protocol error.
  async listResources({ cursor, signal } = {}) {
    if (!this.client) throw new Error(`MCP server "${this.server.name}" is not connected`);
    return this.client.listResources(cursor === undefined ? {} : { cursor }, this._requestOptions(signal));
  }

  async listResourceTemplates({ cursor, signal } = {}) {
    if (!this.client) throw new Error(`MCP server "${this.server.name}" is not connected`);
    return this.client.listResourceTemplates(cursor === undefined ? {} : { cursor }, this._requestOptions(signal));
  }

  async readResource(uri, signal) {
    if (!this.client) throw new Error(`MCP server "${this.server.name}" is not connected`);
    return this.client.readResource({ uri }, this._requestOptions(signal));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const client = this.client;
    this.client = null;
    this.instructions = "";
    this._applyTools(new Map());
    this.onResourcesChanged(this.server.name, false);
    if (client) {
      // close() rejects in-flight requests through the SDK; a failure here must
      // not block shutdown.
      Promise.resolve(client.close()).catch(() => {});
    }
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === "function") this.logger[level](message);
  }
}

// Discovery is part of startup: by the time this resolves, the initial tool
// list is final, so the first model turn already sees every MCP tool. Servers
// that fail their initial handshake are retried within their budget and then
// skipped; the returned handle keeps them alive for later reconnects.
async function loadMcpTools({ logger = console } = {}) {
  const tools = new Map();
  // Server name -> connection for every server that has resource capability.
  const resourceServers = new Map();
  const connections = [];
  const resourceTools = buildResourceTools(() => resourceServers);

  // Every connection writes its own slice of the shared map, so one server
  // coming or going never disturbs another's tools.
  const onToolsChanged = (serverName, next) => {
    const prefix = `mcp__${serverName}__`;
    for (const name of [...tools.keys()]) {
      if (name.startsWith(prefix)) tools.delete(name);
    }
    for (const [name, tool] of next) tools.set(name, tool);
  };

  // The resource tools exist only while at least one server can serve them; the
  // prompt section is derived from the same set by the caller.
  const syncResourceTools = () => {
    const wanted = resourceServers.size > 0;
    for (const [name, tool] of Object.entries(resourceTools)) {
      if (wanted) tools.set(name, tool);
      else tools.delete(name);
    }
  };

  // The callback closes over its own connection rather than looking it up: the
  // first capability report arrives during start(), before the array is filled.
  const makeResourcesChanged = (connection) => (serverName, hasResources) => {
    if (hasResources) resourceServers.set(serverName, connection);
    else resourceServers.delete(serverName);
    syncResourceTools();
  };

  for (const server of readServers(logger)) {
    let connection = null;
    const onResourcesChanged = (serverName, hasResources) => {
      if (connection) makeResourcesChanged(connection)(serverName, hasResources);
    };
    connection = new McpServerConnection(server, { logger, onToolsChanged, onResourcesChanged });
    const ok = await connection.start();
    connections.push(connection);
    if (ok && logger && typeof logger.log === "function") {
      const resourceNote = connection.hasResources ? ", resources available" : "";
      logger.log(`[mcp] server "${server.name}": ${connection.tools.size} tools registered${resourceNote}`);
    }
  }

  syncResourceTools();

  return {
    tools,
    // Server name -> connection, for diagnostics and tests.
    servers: new Map(connections.map((connection) => [connection.server.name, connection])),
    // Sorted names of servers advertising resource capability right now; the
    // resource tools and their prompt section are built from this.
    resourceServerNames: () => [...resourceServers.keys()].sort(),
    resourceProviders: () => new Map(resourceServers),
    // Live server instructions for the prompt: a server that is down contributes
    // nothing, so the prompt never quotes stale server-owned text.
    serverInstructions: () =>
      connections
        .filter((connection) => connection.client && connection.instructions.trim())
        .map((connection) => ({ server: connection.server.name, text: connection.instructions })),
    close() {
      for (const connection of connections) connection.close();
    },
  };
}

const __exports = { loadMcpTools, projectContent, McpServerConnection };
export { loadMcpTools, projectContent, McpServerConnection };
export default __exports;
