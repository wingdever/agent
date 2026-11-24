"use strict";

// Conversation -> session binding for inbound traffic.
//
// A channel conversation is identified by a platform string (`ch:feishu:wing-bot:oc_x`),
// while core addresses sessions by their store id (a number). Without a binding,
// core looks up "ch:feishu:..." in the sessions table, finds nothing, and every
// turn dies with `session not found` — the first real inbound message proved it.
//
// So the entry layer resolves the key once and remembers the answer:
//   conversationKey --binder--> session id --core.agent.chat-->
// The map is persisted because a restart must continue the same conversation, not
// open a new session for the same chat (and re-pay for the same history).
//
// Deliberately not in core: core has no idea what a platform chat is.

import fs from "fs";
import path from "path";

/**
 * @param {Object} options
 * @param {Object} options.store core store (RPC runner: store.run(name, params))
 * @param {string|null} [options.file] persistence path; null keeps it in memory
 * @param {string} [options.workspaceFolder] which workspace new sessions belong to
 */
export function createSessionBinder({ store, file = null, workspaceFolder = null } = {}) {
  if (!store || typeof store.run !== "function") throw new TypeError("session binder needs a store");
  /** @type {Map<string, number>} */
  const bindings = new Map();
  if (file) load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [key, id] of parsed.sessions || []) {
        if (Number.isFinite(Number(id))) bindings.set(key, Number(id));
      }
    } catch (_) {
      // A missing or corrupt map is not fatal: the next turn opens a fresh session.
    }
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [...bindings] }, null, 2));
    } catch (_) {
      // Best effort: an unwritable map costs continuity across restarts only.
    }
  }

  // sessions.workspace_id is NOT NULL (measured: creating one without a workspace
  // fails with a constraint error), so an empty workspace list means creating the
  // workspace first — the bot's conversation files belong next to the project.
  async function workspaceId() {
    const folder = workspaceFolder ? path.resolve(workspaceFolder) : process.cwd();
    let list = [];
    try {
      list = await store.run("workspace.list", {});
    } catch (_) {
      list = [];
    }
    const match = list.find((w) => w && path.resolve(String(w.folder_path || "")) === folder);
    if (match) return match.id;
    if (list.length) return list[0].id;
    const created = await store.run("workspace.create", {
      folder_path: folder,
      folder_name: path.basename(folder) || "workspace",
    });
    return created.id;
  }

  async function exists(id) {
    try {
      return Boolean(await store.run("session.get", { id }));
    } catch (_) {
      return false;
    }
  }

  /**
   * Resolve one conversation key to a live session id, creating the session on
   * first use (or after it was deleted outside the channel).
   * @param {{sessionId?: string, conversationKey?: string, type?: string, instanceId?: string}} message
   * @returns {Promise<number>}
   */
  async function resolve(message) {
    const key = String(message.sessionId || message.conversationKey || "");
    if (!key) throw new TypeError("session binder needs a sessionId or conversationKey");
    const mapped = bindings.get(key);
    if (mapped != null && (await exists(mapped))) return mapped;

    const created = await store.run("session.create", {
      workspace_id: await workspaceId(),
      kind: "normal",
      name: `${message.type || "channel"} · ${message.instanceId || "?"} · ${key.split(":").pop()}`,
      activity: "chat",
    });
    bindings.set(key, created.id);
    persist();
    return created.id;
  }

  return { resolve, size: () => bindings.size, _bindings: bindings };
}
