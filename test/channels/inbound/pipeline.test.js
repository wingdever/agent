"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInboundPipeline } from "../../../channels/inbound/pipeline.js";
import { createDedupe } from "../../../channels/inbound/dedupe.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const message = (over = {}) => ({
  type: "fake",
  instanceId: "f1",
  conversationKey: "chat-a",
  eventId: "evt-1",
  senderId: "u1",
  messages: [],
  raw: {},
  ...over,
});

function pipelineWith(handlers) {
  return createInboundPipeline({ dedupe: createDedupe({ capacity: 16 }), ...handlers });
}

test("a re-delivered event runs the turn exactly once", async () => {
  let runs = 0;
  const pipeline = pipelineWith({ runTurn: async () => void runs++, project: async () => {} });

  const first = pipeline.handle(message({ eventId: "dup" }));
  const second = pipeline.handle(message({ eventId: "dup" }));

  await pipeline.idle();
  assert.equal(runs, 1);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(pipeline.stats.duplicates, 1);
});

test("handle returns before the turn finishes, so the platform can be acked", async () => {
  let finished = false;
  const pipeline = pipelineWith({
    runTurn: async () => {
      await sleep(60);
      finished = true;
    },
    project: async () => {},
  });

  const startedAt = Date.now();
  pipeline.handle(message({ eventId: "ack" }));
  const ackMs = Date.now() - startedAt;

  assert.ok(ackMs < 20, `handle took ${ackMs}ms`);
  assert.equal(finished, false);
  await pipeline.idle();
  assert.equal(finished, true);
});

test("an approval card is projected while the turn is still waiting for the answer", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const projected = [];

  const pipeline = pipelineWith({
    runTurn: async (_message, emit) => {
      emit({ type: "approval-request", id: 1, name: "Bash" });
      await gate;
      emit({ type: "final", content: "done" });
    },
    project: async (_message, event) => {
      projected.push(event.type);
    },
  });

  pipeline.handle(message({ eventId: "live" }));
  await sleep(20);
  // The card must already be out: waiting for the turn to end would deadlock
  // because the turn is waiting for the card's button.
  assert.deepEqual(projected, ["approval-request"]);

  release();
  await pipeline.idle();
  assert.deepEqual(projected, ["approval-request", "final"]);
});

test("two events in one conversation never run concurrently", async () => {
  let active = 0;
  let peak = 0;
  const pipeline = pipelineWith({
    runTurn: async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(15);
      active--;
    },
    project: async () => {},
  });

  pipeline.handle(message({ eventId: "s1" }));
  pipeline.handle(message({ eventId: "s2" }));
  await pipeline.idle();

  assert.equal(peak, 1);
  assert.equal(pipeline.stats.turns, 2);
});

test("events from different conversations are not serialized against each other", async () => {
  let active = 0;
  let peak = 0;
  const pipeline = pipelineWith({
    runTurn: async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
    },
    project: async () => {},
  });

  pipeline.handle(message({ eventId: "c1", conversationKey: "chat-a" }));
  pipeline.handle(message({ eventId: "c2", conversationKey: "chat-b" }));
  await pipeline.idle();

  assert.equal(peak, 2);
});

test("a failing turn still projects a terminal error event", async () => {
  const projected = [];
  const pipeline = pipelineWith({
    runTurn: async () => {
      throw new Error("boom");
    },
    project: async (_message, event) => void projected.push(event),
  });

  pipeline.handle(message({ eventId: "err" }));
  await pipeline.idle();

  assert.equal(projected.length, 1);
  assert.equal(projected[0].type, "error");
  assert.equal(projected[0].kind, "platform");
  assert.ok(pipeline.stats.failures >= 1);
});

test("a message without eventId is refused at intake", () => {
  const pipeline = pipelineWith({ runTurn: async () => {}, project: async () => {} });
  assert.throws(() => pipeline.handle(message({ eventId: "" })), /requires eventId/);
});
