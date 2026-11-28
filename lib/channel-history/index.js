"use strict";

// Message history for the channel service. One SQLite WAL file: the channel
// service writes, core opens the same file read-only (WAL supports one writer
// plus many readers across processes on one host).
//
// The DB handle is injected so the module is testable without a native driver:
//   db.run(sql, params)   → executes DDL/DML
//   db.all(sql, params)   → returns rows as plain objects
// Adapters: createSqliteAdapter (production), createMemoryAdapter (tests).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
    event_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_pending
   ON messages (instance_id, delivered_at, created_at)`,
];

// ACK tracking columns. SQLite has no ADD COLUMN IF NOT EXISTS, so init()
// checks PRAGMA table_info before adding each one.
const ACK_COLUMNS = {
  attempts: `ALTER TABLE messages ADD COLUMN attempts INTEGER DEFAULT 0`,
  last_attempt_at: `ALTER TABLE messages ADD COLUMN last_attempt_at TEXT`,
  // A message that exhausted its retry budget is kept for inspection and
  // manual requeue; it is not silently marked delivered.
  dead_lettered_at: `ALTER TABLE messages ADD COLUMN dead_lettered_at TEXT`,
};

export function createChannelHistory({ db } = {}) {
  if (!db || typeof db.run !== "function" || typeof db.all !== "function") {
    throw new TypeError("createChannelHistory needs a db with run() and all()");
  }
  // DDL may be async. Call init() before any read/write; it is
  // idempotent and safe to call more than once.
  let initPromise = null;
  function init() {
    if (!initPromise) {
      initPromise = (async () => {
        for (const sql of SCHEMA) await db.run(sql);
        const existing = await db.all(`PRAGMA table_info(messages)`);
        const names = new Set(existing.map((r) => r.name));
        for (const [name, sql] of Object.entries(ACK_COLUMNS)) {
          if (!names.has(name)) await db.run(sql);
        }
        // Legacy rows that already hit the old "auto-drop at 5" cap become
        // dead letters instead of silently staying pending forever.
        await db.run(
          `UPDATE messages SET dead_lettered_at = CURRENT_TIMESTAMP
           WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND attempts >= 5`
        );
      })();
    }
    return initPromise;
  }

  /** Persist an inbound/outbound message. Duplicate event_ids are ignored. */
  async function append(message) {
    if (!message || !message.eventId || !message.instanceId) return false;
    await init();
    await db.run(
      `INSERT OR IGNORE INTO messages (event_id, instance_id, conversation_key, payload)
       VALUES (?, ?, ?, ?)`,
      [
        String(message.eventId),
        String(message.instanceId),
        String(message.conversationKey || ""),
        JSON.stringify(message),
      ]
    );
    return true;
  }

  /** Messages not yet delivered to a subscriber, optionally per instance. */
  async function getPending(instanceId = null, limit = 1000) {
    await init();
    const scope = instanceId ? ` AND instance_id = ${`'${String(instanceId).replace(/'/g, "''")}'`}` : "";
    const sql =
      `SELECT payload FROM messages
       WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND attempts < 5${scope}
       ORDER BY created_at ASC LIMIT ?`;
    const rows = await db.all(sql, [limit]);
    return rows.map((row) => {
      try {
        return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  }

  /** Record a publish attempt. Does NOT acknowledge — the core must ACK. */
  async function markPublished(eventIds, { maxAttempts = 5 } = {}) {
    const ids = (Array.isArray(eventIds) ? eventIds : [eventIds]).filter(Boolean).map(String);
    if (!ids.length) return 0;
    await init();
    const placeholders = ids.map(() => "?").join(",");
    const cap = Number(maxAttempts) || 5;
    // One statement: increment and dead-letter at the cap. A crash between two
    // statements would otherwise leave an over-budget message replayable.
    await db.run(
      `UPDATE messages SET
         attempts = attempts + 1,
         last_attempt_at = CURRENT_TIMESTAMP,
         dead_lettered_at = CASE WHEN attempts + 1 >= ${cap} THEN CURRENT_TIMESTAMP ELSE dead_lettered_at END
       WHERE event_id IN (${placeholders}) AND delivered_at IS NULL AND dead_lettered_at IS NULL`,
      ids
    );
    return ids.length;
  }

  /** Messages that exhausted their retry budget, for inspection or requeue. */
  async function getDeadLetters(instanceId = null, limit = 1000) {
    await init();
    const scope = instanceId ? ` AND instance_id = ${`'${String(instanceId).replace(/'/g, "''")}'`}` : "";
    const rows = await db.all(
      `SELECT payload, attempts, dead_lettered_at FROM messages
       WHERE dead_lettered_at IS NOT NULL${scope}
       ORDER BY dead_lettered_at ASC LIMIT ?`,
      [limit]
    );
    return rows.map((row) => {
      try {
        const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        return payload ? { ...payload, attempts: row.attempts, deadLetteredAt: row.dead_lettered_at } : null;
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  }

  /** Put dead-lettered messages back into the pending set with a fresh budget. */
  async function requeueDeadLetters(eventIds) {
    const ids = (Array.isArray(eventIds) ? eventIds : [eventIds]).filter(Boolean).map(String);
    if (!ids.length) return 0;
    await init();
    const placeholders = ids.map(() => "?").join(",");
    const result = await db.run(
      `UPDATE messages SET dead_lettered_at = NULL, attempts = 0, last_attempt_at = NULL
       WHERE event_id IN (${placeholders}) AND dead_lettered_at IS NOT NULL`,
      ids
    );
    return result && Number.isFinite(result.changes) ? result.changes : ids.length;
  }

  /** Acknowledge delivery: the message leaves the pending set. */
  async function ack(eventIds) {
    return markDelivered(eventIds);
  }

  /** Mark messages as delivered so reconnects do not replay them. */
  async function markDelivered(eventIds) {
    const ids = (Array.isArray(eventIds) ? eventIds : [eventIds])
      .filter(Boolean).map(String);
    if (!ids.length) return 0;
    await init();
    const placeholders = ids.map(() => "?").join(",");
    await db.run(
      `UPDATE messages SET delivered_at = CURRENT_TIMESTAMP
       WHERE event_id IN (${placeholders})`,
      ids
    );
    return ids.length;
  }

  /** All messages for a conversation, oldest first — for replay / UI. */
  async function forConversation(instanceId, conversationKey, limit = 200) {
    await init();
    const rows = await db.all(
      `SELECT payload FROM messages
       WHERE instance_id = ? AND conversation_key = ?
       ORDER BY created_at ASC LIMIT ?`,
      [String(instanceId), String(conversationKey), limit]
    );
    return rows.map((row) => {
      try {
        return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  }

  /** Store an outbound message without putting it in the pending queue. */
  async function appendOutbound(message) {
    if (!message || !message.eventId) return false;
    await append(message);
    await markDelivered([message.eventId]);
    return true;
  }

  /**
   * Archive messages older than `olderThanDays` into monthly SQLite files and
   * remove them from the hot table. Each YYYY-MM.db is a standalone SQLite
   * database with the same messages schema; readers ATTACH all archive files.
   * Returns per-month counts.
   */
  async function archive({ olderThanDays = 90, archiveDir = null, now = Date.now, archiveAdapter = null } = {}) {
    await init();
    if (!archiveDir || !db || typeof db.run !== "function") return [];
    const { mkdirSync } = await import("node:fs");
    mkdirSync(archiveDir, { recursive: true });
    const cutoff = new Date(now() - olderThanDays * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ");

    const months = await db.all(
      `SELECT substr(created_at, 1, 7) AS month, count(*) AS n
       FROM messages WHERE created_at < ? AND delivered_at IS NOT NULL
       GROUP BY month ORDER BY month`,
      [cutoffStr]
    );
    const results = [];
    for (const row of months) {
      const month = String(row.month || "");
      const count = Number(row.n) || 0;
      if (!month || count === 0) continue;
      const file = archiveDir.replace(/\/+$/, "") + "/" + month + ".db";
      const rows = await db.all(
        `SELECT * FROM messages
         WHERE substr(created_at, 1, 7) = ? AND created_at < ? AND delivered_at IS NOT NULL`,
        [month, cutoffStr]
      );
      if (archiveAdapter) {
        const store = await archiveAdapter({ file });
        try {
          const write = () => {
            for (const sql of SCHEMA) store.run(sql);
            for (const r of rows) {
              store.run(
                `INSERT OR IGNORE INTO messages
                 (event_id, instance_id, conversation_key, payload, created_at, delivered_at, attempts, last_attempt_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [r.event_id, r.instance_id, r.conversation_key, r.payload, r.created_at, r.delivered_at, r.attempts, r.last_attempt_at]
              );
            }
          };
          if (typeof store.transaction === "function") store.transaction(write);
          else write();
        } finally { store.close(); }
      }
      const remove = () => db.run(
        `DELETE FROM messages
         WHERE substr(created_at, 1, 7) = ? AND created_at < ? AND delivered_at IS NOT NULL`,
        [month, cutoffStr]
      );
      if (typeof db.transaction === "function") db.transaction(remove);
      else await remove();
      results.push({ month, count });
    }
    return results;
  }

  return { init, append, appendOutbound, getPending, getDeadLetters, requeueDeadLetters, markPublished, markDelivered, ack, forConversation, archive };
}

export default { createChannelHistory };
