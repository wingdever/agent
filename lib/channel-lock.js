"use strict";

// Per-instance channel ownership lock, shared by the standalone channel
// service and the app's local channel manager. One lock file = one WebSocket.
//
// Creation is atomic (`open(..., "wx")`), unlike the old read-then-write
// sequence: two processes racing at boot cannot both conclude "no lock".

import fs from "fs";
import path from "path";
import process from "node:process";
import { PROJECT_ROOT } from "./paths/index.js";

export function channelLockFile(instanceId, { dir = null } = {}) {
  const id = String(instanceId || "");
  if (!id) throw new TypeError("channel lock needs an instanceId");
  return path.join(dir || path.join(PROJECT_ROOT, "data", "channels"), `run-${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.lock`);
}

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readHolder(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return null; }
}

/**
 * @returns {{ok: true, file: string, pid: number}|{ok: false, file: string, pid?: number, holder?: Object}}
 */
export function acquireChannelLock(instanceId, { dir = null, now = Date.now } = {}) {
  const file = channelLockFile(instanceId, { dir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, payload);
      fs.closeSync(fd);
      return { ok: true, file, pid: process.pid };
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      const holder = readHolder(file);
      if (holder && holder.pid && alive(holder.pid)) {
        return { ok: false, file, pid: Number(holder.pid), holder };
      }
      // Dead holder or unreadable lock: remove it and retry once. If another
      // process wins that race, EEXIST sends us back through the same check.
      try { fs.unlinkSync(file); } catch (_) { /* someone else removed it */ }
    }
  }
  const holder = readHolder(file);
  if (!holder || !holder.pid) {
    // A corrupt lock we could not remove: refuse rather than double-open.
    return { ok: false, file, holder };
  }
  return { ok: false, file, pid: Number(holder.pid), holder };
}

export function releaseChannelLock(file) {
  try {
    const holder = readHolder(file);
    if (holder && Number(holder.pid) === process.pid) fs.unlinkSync(file);
  } catch (_) {
    // nothing to release
  }
}

export { alive as isPidAlive };
export default { acquireChannelLock, releaseChannelLock, channelLockFile, isPidAlive: alive };
