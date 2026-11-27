"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannelHistory } from "../../lib/channel-history/index.js";

/** Minimal in-memory DB implementing the injected run/all contract. */
function fakeDb() {
  const rows = new Map();
  let schema = [];
  return {
    rows,
    schema: () => schema,
    run(sql, params = []) {
      if (/CREATE TABLE/.test(sql)) { schema.push("messages"); return; }
      if (/CREATE INDEX/.test(sql)) { schema.push("index"); return; }
      if (/INSERT OR IGNORE/.test(sql)) {
        const [id, instance, conv, payload] = params;
        if (!rows.has(id)) rows.set(id, { event_id: id, instance_id: instance, conversation_key: conv, payload, delivered_at: null, attempts: 0 });
        return;
      }
      if (/UPDATE messages SET attempts/.test(sql)) {
        for (const id of params) {
          const row = rows.get(id);
          if (row) { row.attempts = (row.attempts || 0) + 1; row.last_attempt_at = "now"; }
        }
        return;
      }
      if (/UPDATE messages SET delivered_at/.test(sql)) {
        for (const id of params) {
          const row = rows.get(id);
          if (row) row.delivered_at = "now";
        }
      }
    },
    all(sql, params = []) {
      let list = [...rows.values()];
      if (/conversation_key = \?/.test(sql)) {
        list = list.filter((r) => r.instance_id === params[0] && r.conversation_key === params[1]);
      } else if (/instance_id = \?/.test(sql)) {
        list = list.filter((r) => r.instance_id === params[0]);
      } else {
        const lit = sql.match(/instance_id = '([^']*)'/);
        if (lit) list = list.filter((r) => r.instance_id === lit[1]);
      }
      if (/delivered_at IS NULL/.test(sql)) list = list.filter((r) => !r.delivered_at);
      const cap = sql.match(/attempts < (\d+)/);
      if (cap) list = list.filter((r) => (r.attempts || 0) < Number(cap[1]));
      const limit = Number(params[params.length - 1]) || list.length;
      return list.slice(0, limit);
    },
  };
}

function msg(id, instance = "qq-bot", conv = "G1") {
  return { eventId: id, instanceId: instance, conversationKey: conv, messages: [{ role: "user", content: id }] };
}

test("createChannelHistory creates schema and rejects a bad db", () => {
  const db = fakeDb();
  const history = createChannelHistory({ db });
  assert.equal(typeof history.init, "function");
  assert.throws(() => createChannelHistory({ db: {} }), /run\(\) and all/);
});

test("append persists messages and ignores duplicate event ids", async () => {
  const db = fakeDb();
  const history = createChannelHistory({ db });
  assert.equal(await history.append(msg("e1")), true);
  assert.equal(await history.append(msg("e1")), true);
  assert.equal(db.rows.size, 1);
  assert.equal(await history.append(null), false);
});

test("getPending returns undelivered messages, optionally per instance", async () => {
  const db = fakeDb();
  const history = createChannelHistory({ db });
  await history.append(msg("e1", "bot-a", "G1"));
  await history.append(msg("e2", "bot-b", "G2"));
  assert.deepEqual((await history.getPending()).map((m) => m.eventId), ["e1", "e2"]);
  assert.deepEqual((await history.getPending("bot-b")).map((m) => m.eventId), ["e2"]);
});

test("markDelivered removes messages from pending but keeps them in history", async () => {
  const db = fakeDb();
  const history = createChannelHistory({ db });
  await history.append(msg("e1"));
  await history.append(msg("e2"));
  await history.markDelivered(["e1"]);
  assert.deepEqual((await history.getPending()).map((m) => m.eventId), ["e2"]);
  assert.equal((await history.forConversation("qq-bot", "G1")).length, 2);
});

test("appendOutbound records a message without making it pending", async () => {
  const db = fakeDb();
  const history = createChannelHistory({ db });
  await history.appendOutbound({
    eventId: "out-1", instanceId: "qq-bot", conversationKey: "G1",
    messages: [{ role: "assistant", content: "answer" }],
  });
  assert.deepEqual(await history.getPending(), [], "outbound never replays as inbound");
  const rows = await history.forConversation("qq-bot", "G1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messages[0].content, "answer");
});

test("forConversation filters by instance and conversation key", async () => {
  const db = fakeDb();
  const history = createChannelHistory({ db });
  await history.append(msg("a", "bot-a", "G1"));
  await history.append(msg("b", "bot-a", "G2"));
  await history.append(msg("c", "bot-b", "G1"));
  assert.deepEqual((await history.forConversation("bot-a", "G1")).map((m) => m.eventId), ["a"]);
});

test("ACK semantics: published stays pending, ack removes it, attempts cap drops it", async () => {
  const { createSqliteAdapter } = await import("../../lib/channel-history/sqlite-adapter.js");
  const db = await createSqliteAdapter({ file: ":memory:" });
  const history = createChannelHistory({ db });
  try {
    await history.append(msg("ack-1"));
    await history.append(msg("ack-2"));
    await history.append(msg("ack-3"));
    await history.markPublished(["ack-1", "ack-2", "ack-3"]);
    await history.markPublished(["ack-1", "ack-2", "ack-3"]);
    assert.deepEqual((await history.getPending("qq-bot")).map((m) => m.eventId).sort(),
      ["ack-1", "ack-2", "ack-3"], "publish attempts do not acknowledge");

    await history.ack(["ack-1"]);
    assert.deepEqual((await history.getPending("qq-bot")).map((m) => m.eventId).sort(),
      ["ack-2", "ack-3"], "ACK removes only that message");

    await history.markPublished(["ack-2", "ack-3"], { maxAttempts: 2 });
    assert.deepEqual(await history.getPending("qq-bot"), [], "attempts cap auto-drops");
  } finally {
    db.close();
  }
});
