"use strict";

// Core-side history reader. SQLite WAL supports one writer + many readers
// across processes on the same host, so core opens the channel service's
// database file directly in read-only mode — no HTTP endpoint needed.
//
// Archive files (one SQLite db per YYYY-MM) are ATTACHed read-only so replay
// spans hot + archive transparently.

import fs from "node:fs";
import path from "node:path";
import { createSqliteAdapter } from "./sqlite-adapter.js";

export function createChannelHistoryReader({ file = null, archiveDir = null, adapterFactory = createSqliteAdapter, log = () => {} } = {}) {
  let handle = null;
  let archiveHandles = [];

  async function ensure() {
    if (handle) return handle;
    if (!file) throw new Error("channel history reader needs a file");
    handle = await adapterFactory({ file, readonly: true });
    if (archiveDir) {
      let files = [];
      try { files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".db")).sort(); }
      catch (_) { /* no archive dir */ }
      for (const f of files) {
        try {
          const h = await adapterFactory({ file: path.join(archiveDir, f), readonly: true });
          archiveHandles.push(h);
        } catch (err) {
          log(`[channel-history-reader] cannot open archive ${f}: ${(err && err.message) || err}`);
        }
      }
    }
    return handle;
  }

  /** Historical messages for a conversation, oldest first, as chat messages. */
  async function contextMessages(instanceId, conversationKey, limit = 50) {
    if (!instanceId || !conversationKey) return [];
    let rows;
    try {
      await ensure();
      const sources = [handle, ...archiveHandles];
      const collected = [];
      for (const source of sources) {
        const part = await source.all(
          `SELECT payload, created_at FROM messages
           WHERE instance_id = ? AND conversation_key = ?
           ORDER BY created_at ASC LIMIT ?`,
          [String(instanceId), String(conversationKey), limit]
        );
        collected.push(...part);
      }
      rows = collected.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    } catch (err) {
      log(`[channel-history-reader] read failed: ${(err && err.message) || err}`);
      return [];
    }
    const out = [];
    for (const row of rows) {
      let payload;
      try { payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload; }
      catch (_) { continue; }
      if (!payload || !Array.isArray(payload.messages)) continue;
      for (const m of payload.messages) {
        if (!m || !m.content) continue;
        out.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) });
      }
    }
    return out.slice(-limit);
  }

  function close() {
    if (handle) handle.close();
    for (const h of archiveHandles) h.close();
    handle = null;
    archiveHandles = [];
  }

  return { contextMessages, close };
}

export default { createChannelHistoryReader };
