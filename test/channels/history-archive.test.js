"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createChannelHistory } from "../../lib/channel-history/index.js";

// Simple in-memory adapter with enough SQL handling for archive tests.
function makeDb() {
  const rows = new Map();
  return {
    kind: "fake",
    run(sql, params = []) {
      if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/.test(sql)) return;
      if (/INSERT OR IGNORE INTO messages/.test(sql)) {
        const [id, inst, conv, payload, created, delivered, attempts, last] = params;
        if (!rows.has(id)) rows.set(id, {
          event_id: id, instance_id: inst, conversation_key: conv, payload,
          created_at: created || "2026-11-20 10:00:00", delivered_at: delivered || null,
          attempts: attempts || 0, last_attempt_at: last || null,
        });
        return;
      }
      if (/UPDATE messages SET delivered_at/.test(sql)) {
        for (const id of params) { const r = rows.get(id); if (r) r.delivered_at = "now"; }
      }
      if (/DELETE FROM messages/.test(sql)) {
        for (const id of params) rows.delete(id);
      }
    },
    all(sql, params = []) {
      let list = [...rows.values()];
      const lit = sql.match(/instance_id = '([^']*)'/);
      if (lit) list = list.filter((r) => r.instance_id === lit[1]);
      const month = sql.match(/substr\(created_at, 1, 7\) = \?/);
      if (month && params[0]) list = list.filter((r) => String(r.created_at).slice(0, 7) === params[0]);
      if (/delivered_at IS NOT NULL/.test(sql)) list = list.filter((r) => r.delivered_at);
      if (/delivered_at IS NULL/.test(sql)) list = list.filter((r) => !r.delivered_at);
      if (/created_at < \?/.test(sql) && params[0]) {
        list = list.filter((r) => String(r.created_at) < String(params[0]));
      }
      const cap = sql.match(/attempts < (\d+)/);
      if (cap) list = list.filter((r) => (r.attempts || 0) < Number(cap[1]));
      // GROUP BY month aggregation (after row filters)
      if (/GROUP BY month/.test(sql)) {
        const counts = new Map();
        for (const r of list) {
          const m = String(r.created_at).slice(0, 7);
          counts.set(m, (counts.get(m) || 0) + 1);
        }
        return [...counts.entries()].map(([m, n]) => ({ month: m, n }));
      }
      return list;
    },
    close() {},
  };
}

test("archive exports old delivered months to a separate db and deletes hot rows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-sqlite-"));
  const archiveDir = path.join(dir, "archive");
  const db = makeDb();
  const history = createChannelHistory({ db });
  await history.init();
  db.run("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?)",
    ["old-1", "qq-bot", "G1", "{}", "2026-01-15 10:00:00", "2026-01-15 11:00:00", 0, null]);
  db.run("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?)",
    ["recent-1", "qq-bot", "G1", "{}", "2026-11-23 10:00:00", "2026-11-23 11:00:00", 0, null]);
  db.run("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?)",
    ["pending-old", "qq-bot", "G1", "{}", "2026-01-16 10:00:00", null, 0, null]);

  const archivedFiles = [];
  const archiveAdapter = async (opts) => {
    archivedFiles.push(opts.file);
    return makeDb();
  };
  const result = await history.archive({
    olderThanDays: 90, archiveDir, now: () => Date.parse("2026-11-25T12:00:00Z"), archiveAdapter,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].month, "2026-01");
  assert.ok(archivedFiles[0].endsWith("2026-01.db"));
  assert.equal((await history.getPending("qq-bot")).length, 1, "old pending kept");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive is a no-op without archiveDir", async () => {
  const history = createChannelHistory({ db: makeDb() });
  await history.init();
  assert.deepEqual(await history.archive({ olderThanDays: 90, archiveDir: null }), []);
});
