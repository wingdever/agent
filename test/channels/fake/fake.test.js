"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createChannel } from "../../../channels/fake/index.js";
import { assertChannel } from "../../../channels/contract.js";
import { createInboundPipeline } from "../../../channels/inbound/pipeline.js";
import { createDedupe } from "../../../channels/inbound/dedupe.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const message = (over = {}) => ({
  type: "fake",
  instanceId: "fake-a",
  conversationKey: "oc_1",
  eventId: "evt-1",
  senderId: "u1",
  messages: [{ role: "user", content: "hi" }],
  raw: {},
  ...over,
});

test("the fake driver is a valid channel", () => {
  const channel = createChannel({ instance: { id: "fake-a" } });
  assertChannel(channel);
  assert.equal(channel.type, "fake");
  assert.equal(channel.instanceId, "fake-a");
  assert.equal(channel.capabilities.ackDeadlineMs, 3000);
});

test("ack beats the platform deadline while a turn is still running", async () => {
  const channel = createChannel({ instance: { id: "fake-a" } });
  const pipeline = createInboundPipeline({
    dedupe: createDedupe({ capacity: 8 }),
    runTurn: async (_message, emit) => {
      emit({ type: "token", content: "hi" });
      await sleep(80);
      emit({ type: "turn-end" });
    },
    project: (m, e) => channel.project(m, e),
  });
  await channel.start((m) => pipeline.handle(m));

  const ackMs = await channel.inject(message({ eventId: "f1" }));
  assert.ok(ackMs < channel.capabilities.ackDeadlineMs, `ack took ${ackMs}ms`);

  await pipeline.idle();
  assert.equal(channel.projections.length, 2);
  assert.equal(channel.projections[0].event.type, "token");
  assert.equal(channel.projections[1].event.type, "turn-end");
  assert.ok(channel.projections[0].sessionId.startsWith("ch:fake:fake-a:"));
});

test("an auth rejection invalidates the credential and the send still lands", async () => {
  const channel = createChannel({ instance: { id: "fake-b" } });
  channel.failNextAuth();
  await channel.send("hello");
  assert.equal(channel.sends.length, 1);
  assert.equal(channel.invalidations, 1);
});

test("oversized text is segmented under the platform cap", async () => {
  const channel = createChannel({ instance: { id: "fake-c" } });
  await channel.send("y".repeat(channel.capabilities.maxTextBytes * 3));
  assert.ok(channel.sends.length >= 3);
  for (const piece of channel.sends) {
    assert.ok(Buffer.byteLength(piece, "utf8") <= channel.capabilities.maxTextBytes);
  }
});

test("stop() detaches the handler so no message is accepted after it", async () => {
  const channel = createChannel({ instance: { id: "fake-d" } });
  await channel.start(async () => {});
  await channel.stop();
  await assert.rejects(() => channel.inject(message()), /not started/);
});
