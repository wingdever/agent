"use strict";

// Transport construction for MCP servers. Both transports come from the official
// SDK, so tool calls, resource calls and list-change notifications share one
// protocol implementation; the connection lifecycle (reconnect, re-sync, tool
// table updates) lives in ./index.js.
//
// The parent environment is scrubbed before it reaches a child process: names
// that look like credentials and the AGENT_* switches are dropped, and only the
// server's own `env` block is merged back.

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i;

function scrubbedParentEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CREDENTIAL_NAME.test(key) || key.startsWith("AGENT_")) continue;
    env[key] = value;
  }
  // `env` in user/mcp.json is authoritative for the server; it is not merged
  // with the scrubbed parent beyond overriding same-named keys.
  for (const [key, value] of Object.entries(extra || {})) env[key] = value;
  return env;
}

// stdio servers write diagnostics to stderr. The pipe must be drained, or the
// child blocks once the buffer fills; each line is prefixed so a noisy server is
// attributable when several run at once.
function drainStderr(transport, name, logger) {
  const stream = transport.stderr;
  if (!stream) return;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const text = String(chunk).trimEnd();
    if (text && logger && typeof logger.warn === "function") logger.warn(`[mcp:${name}] ${text}`);
  });
}

function createTransport(server, logger) {
  let transport;
  if (server.transport === "streamable-http") {
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    });
  } else {
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: scrubbedParentEnv(server.env),
      cwd: server.cwd,
      stderr: "pipe",
    });
    drainStderr(transport, server.name, logger);
  }
  return transport;
}

const __exports = { createTransport, scrubbedParentEnv };
export { createTransport, scrubbedParentEnv };
export default __exports;
