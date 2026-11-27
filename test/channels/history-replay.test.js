"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannelCallback } from "../../channels/callback.js";
import { createChannelHistory } from "../../lib/channel-history/index.js";
import { createMemoryAdapter } from "../../lib/channel-history/adapters.js";
import { createChannelListener, stopAllListeners } from "../../lib/channel-listen/index.js";

function fakeChannel() {
  return { type: "qq", instanceId: "qq-bot", async project() {} };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

test("message published with no subscriber stays pending and replays on subscribe", async () => {
  stopAllListeners();
  const history = createChannelHistory({ db: createMemoryAdapter() });
  const service = createChannelCallback({
    lookupChannel: () => fakeChannel(),
    getPending: (instanceId) => history.getPending(instanceId),
    onReplay: (messages) => history.markDelivered(messages.map((m) => m.eventId)),
    log: () => {},
  });
  const addr = await service.listen();

  const message = {
    eventId: "late-1", instanceId: "qq-bot", conversationKey: "G1",
    messages: [{ role: "user", content: "queued" }],
  };
  await history.append(message);
  const noSubscriber = service.publish(message);
  assert.equal(noSubscriber.sent, 0);
  assert.equal((await history.getPending("qq-bot")).length, 1, "stays pending while nobody is subscribed");

  const seen = [];
  const listener = createChannelListener({
    endpoint: addr.url, instanceId: "qq-bot", onMessage: (m) => seen.push(m), schedule: () => {},
  });
  listener.start();
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].eventId, "late-1");
  await waitFor(async () => (await history.getPending("qq-bot")).length === 0);
  assert.equal((await history.getPending("qq-bot")).length, 0, "replayed message marked delivered");

  listener.stop();
  await service.close();
  stopAllListeners();
});

test("a delivered message is not replayed on a second subscribe", async () => {
  stopAllListeners();
  const history = createChannelHistory({ db: createMemoryAdapter() });
  const service = createChannelCallback({
    lookupChannel: () => fakeChannel(),
    getPending: (instanceId) => history.getPending(instanceId),
    onReplay: (messages) => history.markDelivered(messages.map((m) => m.eventId)),
    log: () => {},
  });
  const addr = await service.listen();

  const message = { eventId: "once", instanceId: "qq-bot", conversationKey: "G1", messages: [] };
  await history.append(message);
  await history.markDelivered(["once"]);

  const seen = [];
  const listener = createChannelListener({
    endpoint: addr.url, instanceId: "qq-bot", onMessage: (m) => seen.push(m), schedule: () => {},
  });
  listener.start();
  await waitFor(() => service.subscriberCount() === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, 0, "delivered message not replayed");

  listener.stop();
  await service.close();
  stopAllListeners();
});

test("POST /proactive bundles send + ACK via ackEventId", async () => {
  stopAllListeners();
  const history = createChannelHistory({ db: createMemoryAdapter() });
  let acked = [];
  const service = createChannelCallback({
    lookupChannel: () => ({ type: "qq", instanceId: "qq-bot", async project() {} }),
    getPending: (i) => history.getPending(i),
    onReplay: (msgs) => history.markPublished(msgs.map((m) => m.eventId)),
    onAck: async (ids) => { acked = ids; await history.ack(ids); },
    log: () => {},
  });
  const addr = await service.listen();
  try {
    await history.append({ eventId: "ack-http", instanceId: "qq-bot", conversationKey: "G", messages: [] });
    const res = await fetch(addr.sendUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "qq-bot", conversationKey: "G", text: "hi", ackEventId: "ack-http" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.deepEqual(acked, ["ack-http"], "ACK bundled into proactive");
    assert.equal((await history.getPending("qq-bot")).length, 0);

    // failed turn: status=failed ACKs without sending
    await history.append({ eventId: "fail-http", instanceId: "qq-bot", conversationKey: "G", messages: [] });
    const failed = await fetch(addr.sendUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "qq-bot", conversationKey: "G", text: "", status: "failed", ackEventId: "fail-http" }),
    });
    assert.equal(failed.status, 200);
    assert.equal((await failed.json()).ackOnly, true);
    assert.deepEqual(acked, ["fail-http"]);
    assert.equal((await history.getPending("qq-bot")).length, 0);
  } finally {
    await service.close();
    stopAllListeners();
  }
});
