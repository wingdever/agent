"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertChannel, channelProblems, EVENT_MODES } from "../../channels/contract.js";
import { createChannel as createFake } from "../../channels/fake/index.js";

test("a real driver satisfies the contract", () => {
  const channel = createFake({ instance: { id: "contract-ok" } });
  assert.doesNotThrow(() => assertChannel(channel));
  assert.equal(channelProblems(channel).length, 0);
});

test("ackDeadlineMs of Infinity is refused instead of accepted as 'no constraint'", () => {
  const channel = createFake({ instance: { id: "contract-inf" } });
  channel.capabilities = { ...channel.capabilities, ackDeadlineMs: Infinity };
  assert.throws(() => assertChannel(channel), /ackDeadlineMs must be a positive finite number/);
});

test("an unknown event mode is refused", () => {
  const channel = createFake({ instance: { id: "contract-mode" } });
  channel.capabilities = { ...channel.capabilities, eventMode: "carrier-pigeon" };
  assert.throws(() => assertChannel(channel), /eventMode must be one of ws\|webhook\|reverse-ws\|poll/);
});

test("all problems are reported in one throw", () => {
  const problems = channelProblems({});
  assert.ok(problems.length >= 6, `expected several problems, got ${problems.length}`);
  assert.throws(() => assertChannel({}), /invalid channel/);
});

test("event modes match the documented deployment set", () => {
  assert.deepEqual([...EVENT_MODES], ["ws", "webhook", "reverse-ws", "poll"]);
});
