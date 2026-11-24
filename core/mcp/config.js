"use strict";

// Read and validate user/mcp.json. One enabled entry becomes one stdio child
// process; invalid entries are skipped with an error instead of aborting startup.

import config from "./../config/index.js";
import { PROJECT_ROOT } from "./../../lib/paths/index.js";

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RECONNECT = 3;
// A server that keeps reporting progress is allowed to run this many budgets in
// total; without a cap, steady progress would mean "never times out".
const DEFAULT_MAX_TOTAL_BUDGETS = 10;
const STREAMABLE_HTTP = "streamable-http";

function log(logger, level, message) {
  if (logger && typeof logger[level] === "function") logger[level](message);
}

function expand(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    if (name === "PROJECT_ROOT") return PROJECT_ROOT;
    const fromEnv = process.env[name];
    return fromEnv === undefined ? whole : fromEnv;
  });
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// 0 disables reconnect; anything unusable falls back to the default rather than
// silently turning retries off.
function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// The child inherits the process environment minus credential-looking names and
// AGENT_* switches; anything a server needs is declared in its own `env`.
function scrubbedEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CREDENTIAL_NAME.test(key) || key.startsWith("AGENT_")) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) env[key] = expand(value);
  return env;
}

function readServers(logger) {
  const raw = config.readMcp();
  const servers = raw && raw.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];

  const out = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      log(logger, "error", `[mcp] invalid server name "${name}" (use [A-Za-z0-9_-]{1,32})`);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.enabled === false) continue;

    // `transport` defaults from what the entry provides, so the common shapes
    // need only `command` (stdio) or `url` (streamable-http).
    const declared = typeof entry.transport === "string" ? entry.transport : "";
    const transport = declared || (entry.url ? STREAMABLE_HTTP : "stdio");
    if (transport !== "stdio" && transport !== STREAMABLE_HTTP) {
      log(logger, "error", `[mcp] server "${name}": unknown transport "${transport}"`);
      continue;
    }

    const timeoutMs = positiveNumber(entry.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const base = {
      name,
      timeoutMs,
      // Total wall-clock cap for a progress-reporting request.
      maxTotalMs: timeoutMs * positiveNumber(entry.maxTotalBudgets) || timeoutMs * DEFAULT_MAX_TOTAL_BUDGETS,
      reconnect: nonNegativeInteger(entry.reconnect, DEFAULT_RECONNECT),
    };

    if (transport === STREAMABLE_HTTP) {
      const url = typeof entry.url === "string" ? expand(entry.url.trim()) : "";
      if (!/^https?:\/\//i.test(url)) {
        log(logger, "error", `[mcp] server "${name}" needs an http(s) url`);
        continue;
      }
      const headers = {};
      const rawHeaders = entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
        ? entry.headers
        : {};
      for (const [key, value] of Object.entries(rawHeaders)) headers[key] = expand(value);
      out.push({ ...base, transport, url, headers });
      continue;
    }

    const command = typeof entry.command === "string" ? expand(entry.command.trim()) : "";
    if (!command) {
      log(logger, "error", `[mcp] server "${name}" has no command`);
      continue;
    }
    const rawEnv = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env : {};
    out.push({
      ...base,
      transport,
      command,
      args: Array.isArray(entry.args) ? entry.args.map((arg) => expand(String(arg))) : [],
      env: scrubbedEnv(rawEnv),
      cwd: entry.cwd ? expand(String(entry.cwd)) : PROJECT_ROOT,
    });
  }
  return out;
}

const __exports = { readServers, DEFAULT_RECONNECT, DEFAULT_MAX_TOTAL_BUDGETS, STREAMABLE_HTTP };
export { readServers, DEFAULT_RECONNECT, DEFAULT_MAX_TOTAL_BUDGETS, STREAMABLE_HTTP };
export default __exports;
