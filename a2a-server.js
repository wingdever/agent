#!/usr/bin/env node
"use strict";

// Standalone A2A inbound server. It is the HTTP sibling of acp-server.js:
// both are edge adapters over the same core session/turn runtime.

import path from "path";
import { createCore } from "./core/index.js";
import { A2AHttpServer } from "./core/a2a/http.js";

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) return process.argv[idx + 1];
  return process.env[`A2A_${name.toUpperCase().replace(/-/g, "_")}`] || fallback;
}

async function main() {
  const instanceId = option("instance", "default");
  const name = option("name", "Micro Agent");
  const host = option("host", "127.0.0.1");
  const port = Number(option("port", "8787"));
  const workspacePath = path.resolve(option("workspace", process.cwd()));
  const tokenEnv = option("token-env", "A2A_TOKEN");
  const token = option("token", null) || (tokenEnv ? process.env[tokenEnv] : null);
  const approvalPolicy = option("approval-policy", "deny");
  const baseUrl = option("base-url", `http://${host}:${port}`);

  const core = await createCore();
  await core.a2a.ensureInstance({
    instanceId,
    name,
    workspacePath,
    tokenEnv,
    approvalPolicy,
  });
  const server = new A2AHttpServer({
    service: core.a2a,
    instanceId,
    host,
    port,
    baseUrl,
    token,
  });
  const address = await server.start();
  process.stderr.write(`[a2a] listening on ${address.baseUrl}/a2a/${instanceId}\n`);
  process.stderr.write(`[a2a] card: ${address.baseUrl}/a2a/${instanceId}/agent-card.json\n`);

  const shutdown = async () => {
    await server.stop();
    if (core.browser) await core.browser.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[a2a] failed: ${err && err.stack || err}\n`);
  process.exit(1);
});
