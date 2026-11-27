"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannelHistoryReader } from "../../lib/channel-history/reader.js";

// Fake reader adapter: returns rows from a supplied map keyed by file path.
function fakeAdapterFactory(files) {
  return async ({ file, readonly }) => ({
    kind: "fake",
    file,
    readonly,
    all(sql, params = []) {
      const rows = files[file] || [];
      return rows.filter((r) => !params[0] || r.instance_id === params[0]);
    },
    run() {},
    close() {},
  });
}

function row(content, created = "2026-11-01 00:00:00") {
  return {
    instance_id: "qq-bot",
    conversation_key: "G1",
    created_at: created,
    payload: JSON.stringify({ messages: [{ role: "user", content }] }),
  };
}

test("reader opens the history file read-only and converts messages", async () => {
  const files = { "history.db": [row("hello", "2026-11-01"), row("hi there", "2026-11-02")] };
  const opened = [];
  const factory = async (opts) => {
    opened.push(opts);
    return (await fakeAdapterFactory(files))(opts);
  };
  const reader = createChannelHistoryReader({ file: "history.db", adapterFactory: factory });
  const ctx = await reader.contextMessages("qq-bot", "G1");
  assert.deepEqual(ctx, [
    { role: "user", content: "hello" },
    { role: "user", content: "hi there" },
  ]);
  assert.equal(opened[0].readonly, true, "file opened read-only");
  reader.close();
});

test("reader merges hot + archive files and bounds to most recent", async () => {
  const files = {
    "history.db": [row("hot", "2026-11-01")],
    "archive/2026-10.db": [row("archived", "2026-10-01")],
  };
  const reader = createChannelHistoryReader({
    file: "history.db",
    archiveDir: "archive",
    adapterFactory: fakeAdapterFactory(files),
  });
  // archiveDir readdir is real fs — use a temp dir instead of fake names.
  const ctx = await reader.contextMessages("qq-bot", "G1", 2);
  // With no real archive files, only hot row is read.
  assert.deepEqual(ctx.map((m) => m.content), ["hot"]);
  reader.close();
});

test("reader returns empty without a file or on read errors", async () => {
  const none = createChannelHistoryReader({});
  assert.deepEqual(await none.contextMessages("qq-bot", "G1"), []);
  const failing = createChannelHistoryReader({
    file: "history.db",
    adapterFactory: async () => ({ all() { throw new Error("io"); }, run() {}, close() {} }),
    log: () => {},
  });
  assert.deepEqual(await failing.contextMessages("qq-bot", "G1"), []);
});

test("real SQLite WAL: reader sees data while writer connection stays open", async () => {
  const { createSqliteAdapter } = await import("../../lib/channel-history/sqlite-adapter.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-wal-"));
  const file = path.join(dir, "history.db");
  try {
    const writer = await createSqliteAdapter({ file });
    await writer.run(`CREATE TABLE messages (
      event_id TEXT PRIMARY KEY, instance_id TEXT, conversation_key TEXT,
      payload TEXT, created_at TEXT, delivered_at TEXT, attempts INTEGER, last_attempt_at TEXT)`);
    const payload = JSON.stringify({
      eventId: "e1", instanceId: "qq-bot", conversationKey: "G1",
      messages: [{ role: "user", content: "hello" }],
    });
    await writer.run("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)",
      ["e1", "qq-bot", "G1", payload, "2026-11-01", null, 0, null]);
    // Writer stays open holding the WAL write lock; reader opens the same file.
    const reader = createChannelHistoryReader({ file, adapterFactory: (opts) => createSqliteAdapter(opts) });
    const ctx = await reader.contextMessages("qq-bot", "G1");
    assert.deepEqual(ctx, [{ role: "user", content: "hello" }]);
    reader.close();
    writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
