"use strict";

// Pause snapshots (docs/runtime/turn-pause.md §4): the one thing that must
// survive closing the app so a paused turn can be continued after a restart.
//
// Two pieces with separate jobs:
//   - the `snapshots` table is the index: one row per session whose snapshot
//     is worth reading on the next start. It is cleared as soon as the start
//     path has read the file, so a row never outlives its purpose.
//   - `data/snapshots/<session>.json` is the snapshot: the state, where the
//     turn stopped, and the next-step inputs that were still queued. Files are
//     kept after being read and simply overwritten by the next quit.
//
// The module owns its table (the generic Store only supplies primitives), so
// adding pause persistence touches only this directory.

import fs from "node:fs/promises";
import path from "node:path";

const TABLE = "snapshots";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  session_id  text      PRIMARY KEY,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
)`;

function sessionKey(sessionId) {
  return String(sessionId);
}

class SnapshotStore {
  constructor({ store, dir }) {
    if (!store) throw new Error("SnapshotStore requires a store");
    this.store = store;
    this.db = store.db;
    this.dir = dir;
    this.ready = null;
  }

  ensureSchema() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.db.exec(CREATE_TABLE);
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  fileFor(sessionId) {
    return path.join(this.dir, sessionKey(sessionId) + ".json");
  }

  // Write one snapshot: the file first, then the index row. A failure leaves
  // no row, so the next start never reads a half-written file.
  async write(sessionId, snapshot) {
    await this.ensureSchema();
    await fs.mkdir(this.dir, { recursive: true });
    const body = {
      state: snapshot.state,
      pausedAt: snapshot.pausedAt || null,
      continueAt: snapshot.continueAt || null,
      nextStep: Array.isArray(snapshot.nextStep) ? snapshot.nextStep : [],
    };
    await fs.writeFile(this.fileFor(sessionId), JSON.stringify(body, null, 2), "utf8");
    const existing = await this.db.prepare(`SELECT session_id FROM ${TABLE} WHERE session_id=$1`).get(sessionKey(sessionId));
    if (!existing) {
      await this.db.prepare(`INSERT INTO ${TABLE} (session_id) VALUES ($1)`).run(sessionKey(sessionId));
    }
    return body;
  }

  // Every session the start path should look at, oldest index row first.
  async listIndex() {
    await this.ensureSchema();
    const rows = await this.db.prepare(`SELECT session_id FROM ${TABLE} ORDER BY created_at, session_id`).all();
    return rows.map((row) => String(row.session_id));
  }

  // Read one snapshot. A missing or unreadable file is reported as null: the
  // session then has no snapshot and is simply idle.
  async read(sessionId) {
    try {
      const text = await fs.readFile(this.fileFor(sessionId), "utf8");
      const body = JSON.parse(text);
      if (!body || typeof body !== "object") return null;
      return {
        state: body.state === "paused" ? "paused" : body.state === "running" ? "running" : "idle",
        pausedAt: body.pausedAt === "before-tools" || body.pausedAt === "before-model" ? body.pausedAt : null,
        continueAt: body.continueAt && typeof body.continueAt === "object" ? body.continueAt : null,
        nextStep: Array.isArray(body.nextStep) ? body.nextStep : [],
      };
    } catch (_) {
      return null;
    }
  }

  // Drop the index row: the start path has read the file of this session.
  async clearIndex(sessionId) {
    await this.ensureSchema();
    await this.db.prepare(`DELETE FROM ${TABLE} WHERE session_id=$1`).run(sessionKey(sessionId));
  }
}

function createSnapshotStore({ store, dir }) {
  return new SnapshotStore({ store, dir });
}

const __exports = { SnapshotStore, createSnapshotStore, CREATE_TABLE, TABLE };
export { SnapshotStore, createSnapshotStore, CREATE_TABLE, TABLE };
export default __exports;
