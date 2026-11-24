"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutboundQueue } from "../../../accounts/outbound/queue.js";
import { ChannelError, ERROR_KINDS } from "../../../accounts/errors.js";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

test("pacing honors the instance qps", async () => {
  const clock = fakeClock();
  const queue = createOutboundQueue({ qps: 2, now: clock.now, sleep: clock.sleep });
  const sentAt = [];
  for (let i = 0; i < 3; i++) {
    await queue.push(async () => {
      sentAt.push(clock.now());
    });
  }
  assert.deepEqual(sentAt, [0, 500, 1000]);
});

test("a retryable failure is retried with backoff", async () => {
  const clock = fakeClock();
  const queue = createOutboundQueue({ qps: 10, now: clock.now, sleep: clock.sleep, backoffMs: 50 });
  let attempts = 0;
  const value = await queue.push(async () => {
    attempts++;
    if (attempts === 1) throw new ChannelError(ERROR_KINDS.RETRYABLE, "rate limited", { status: 429 });
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(attempts, 2);
  assert.equal(queue.stats.retried, 1);
});

test("an auth failure invalidates the credential and retries once", async () => {
  const clock = fakeClock();
  let invalidations = 0;
  const auth = { invalidate: async () => void invalidations++ };
  const queue = createOutboundQueue({ qps: 10, now: clock.now, sleep: clock.sleep, auth });
  let attempts = 0;
  await queue.push(async () => {
    attempts++;
    if (attempts === 1) throw new ChannelError(ERROR_KINDS.AUTH, "token expired", { status: 401 });
    return "ok";
  });
  assert.equal(attempts, 2);
  assert.equal(invalidations, 1);
  assert.equal(queue.stats.reauthenticated, 1);
});

test("a platform refusal is not retried", async () => {
  const clock = fakeClock();
  const queue = createOutboundQueue({ qps: 10, now: clock.now, sleep: clock.sleep });
  let attempts = 0;
  await assert.rejects(
    () =>
      queue.push(async () => {
        attempts++;
        throw new ChannelError(ERROR_KINDS.PLATFORM, "denied by platform", { status: 400 });
      }),
    /denied by platform/
  );
  assert.equal(attempts, 1);
  assert.equal(queue.stats.failed, 1);
});

test("sends stay serial even when callers do not await", async () => {
  const clock = fakeClock();
  const queue = createOutboundQueue({ qps: 4, now: clock.now, sleep: clock.sleep });
  const order = [];
  await Promise.all([
    queue.push(async () => void order.push("a")),
    queue.push(async () => void order.push("b")),
  ]);
  assert.deepEqual(order, ["a", "b"]);
});
