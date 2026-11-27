"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannelCallback } from "../../channels/callback.js";
import { createChannelListener, stopAllListeners } from "../../lib/channel-listen/index.js";

function fakeChannel() {
  return { type: "qq", instanceId: "qq-bot", async project() {} };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

test("listener receives published messages through the real HTTP stream", async () => {
  stopAllListeners();
  const service = createChannelCallback({ lookupChannel: () => fakeChannel(), log: () => {} });
  const addr = await service.listen();
  const seen = [];
  const listener = createChannelListener({
    endpoint: addr.url, instanceId: "qq-bot", onMessage: (m) => seen.push(m), schedule: () => {},
  });
  listener.start();
  await waitFor(() => service.subscriberCount() === 1);

  service.publish({
    type: "message", eventId: "e1", instanceId: "qq-bot", conversationKey: "G1",
    messages: [{ role: "user", content: "hello" }],
  });
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].eventId, "e1");
  assert.equal(seen[0].messages[0].content, "hello");

  listener.stop();
  await service.close();
  stopAllListeners();
});

test("instanceId filter keeps another bot's messages out", async () => {
  stopAllListeners();
  const service = createChannelCallback({ lookupChannel: () => fakeChannel(), log: () => {} });
  const addr = await service.listen();
  const seenA = [];
  const listener = createChannelListener({
    endpoint: addr.url, instanceId: "bot-a", onMessage: (m) => seenA.push(m), schedule: () => {},
  });
  listener.start();
  await waitFor(() => service.subscriberCount() === 1);

  service.publish({ eventId: "for-b", instanceId: "bot-b", conversationKey: "G", messages: [] });
  service.publish({ eventId: "for-a", instanceId: "bot-a", conversationKey: "G", messages: [] });
  await waitFor(() => seenA.length === 1);
  assert.equal(seenA[0].eventId, "for-a");

  listener.stop();
  await service.close();
  stopAllListeners();
});

test("reconnecting listener replays pending messages from getPending", async () => {
  stopAllListeners();
  const pending = [
    { eventId: "p1", instanceId: "qq-bot", conversationKey: "G", messages: [{ role: "user", content: "queued" }] },
  ];
  const service = createChannelCallback({
    lookupChannel: () => fakeChannel(), getPending: () => pending.slice(), log: () => {},
  });
  const addr = await service.listen();
  const seen = [];
  const listener = createChannelListener({
    endpoint: addr.url, instanceId: "qq-bot", onMessage: (m) => seen.push(m), schedule: () => {},
  });
  listener.start();
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].eventId, "p1");

  listener.stop();
  await service.close();
  stopAllListeners();
});

test("closing the service removes subscribers", async () => {
  stopAllListeners();
  const service = createChannelCallback({ lookupChannel: () => fakeChannel(), log: () => {} });
  const addr = await service.listen();
  const listener = createChannelListener({
    endpoint: addr.url, instanceId: "qq-bot", onMessage: () => {}, schedule: () => {},
  });
  listener.start();
  await waitFor(() => service.subscriberCount() === 1);
  await service.close();
  assert.equal(service.subscriberCount(), 0);
  listener.stop();
  stopAllListeners();
});
