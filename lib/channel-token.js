"use strict";

// Shared bearer token for the local channel-service HTTP surface.
//
// The endpoints bind 127.0.0.1, but "localhost" is not an identity boundary:
// any process running as the same user can read the SSE stream or send as the
// bot. A token file with 0600 permissions is the minimum trust boundary.
//
// CHANNEL_SERVICE_TOKEN wins when set. Otherwise the channel service and core
// share data/channels/service-token, created atomically once.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./paths/index.js";

export function serviceTokenFile({ dir = null } = {}) {
  return path.join(dir || path.join(PROJECT_ROOT, "data", "channels"), "service-token");
}

export function readServiceToken({ dir = null, env = process.env } = {}) {
  if (env && env.CHANNEL_SERVICE_TOKEN) return String(env.CHANNEL_SERVICE_TOKEN);
  try {
    const value = fs.readFileSync(serviceTokenFile({ dir }), "utf8").trim();
    return value || null;
  } catch (_) {
    return null;
  }
}

/** Read the token, creating it atomically if this is the first process. */
export function ensureServiceToken({ dir = null, env = process.env } = {}) {
  if (env && env.CHANNEL_SERVICE_TOKEN) return String(env.CHANNEL_SERVICE_TOKEN);
  const file = serviceTokenFile({ dir });
  const existing = readServiceToken({ dir, env: { ...env, CHANNEL_SERVICE_TOKEN: "" } });
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, token + "\n"); } finally { fs.closeSync(fd); }
    return token;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      const raced = readServiceToken({ dir, env: { ...env, CHANNEL_SERVICE_TOKEN: "" } });
      if (raced) return raced;
    }
    throw err;
  }
}

export function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default { serviceTokenFile, readServiceToken, ensureServiceToken, authHeaders };
