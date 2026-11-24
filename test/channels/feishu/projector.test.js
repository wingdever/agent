"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjector } from "../../../channels/feishu/projector.js";

function fakeApi() {
  const sent = [];
  const patches = [];
  return {
    sent,
    patches,
    sendCard: async ({ receiveId, text }) => {
      sent.push({ receiveId, text });
      return `om_${sent.length}`;
    },
    patchCard: async (messageId, text) => {
      patches.push({ messageId, text });
    },
  };
}

test("intermediate tokens are throttled, the terminal event always flushes", async () => {
  const api = fakeApi();
  const projector = createProjector({ api, throttleMs: 1000, now: () => 0 });
  const message = { conversationKey: "oc_1" };

  await projector.push(message, { type: "token", content: "a" });
  await projector.push(message, { type: "token", content: "b" });
  await projector.push(message, { type: "token", content: "c" });
  assert.equal(api.sent.length, 1);
  assert.equal(api.patches.length, 0, "tokens inside the throttle window must not be patched");

  await projector.push(message, { type: "turn-end" });
  assert.equal(api.patches.length, 1);
  assert.equal(api.patches[0].text, "abc", "the final patch must carry the whole reply");
  assert.equal(projector.size(), 0, "terminal event must clear the conversation state");
});

test("with no throttle every token is patched", async () => {
  const api = fakeApi();
  const projector = createProjector({ api, throttleMs: 0, now: () => 0 });
  const message = { conversationKey: "oc_2" };

  await projector.push(message, { type: "token", content: "a" });
  await projector.push(message, { type: "token", content: "b" });
  await projector.push(message, { type: "token", content: "c" });
  await projector.push(message, { type: "turn-end" });

  assert.equal(api.sent.length, 1);
  assert.equal(api.patches.length, 3);
  assert.equal(api.patches.at(-1).text, "abc");
});

test("an error event is shown on the card instead of failing silently", async () => {
  const api = fakeApi();
  const projector = createProjector({ api, throttleMs: 1000, now: () => 0 });
  const message = { conversationKey: "oc_3" };

  await projector.push(message, { type: "token", content: "部分输出" });
  await projector.push(message, { type: "error", message: "模型超时" });

  assert.equal(api.patches.length, 1);
  assert.match(api.patches[0].text, /部分输出/);
  assert.match(api.patches[0].text, /模型超时/);
  assert.equal(projector.size(), 0);
});

test("core's token delta becomes the card text", async () => {
  const api = fakeApi();
  const projector = createProjector({ api, throttleMs: 1000, now: () => 0 });
  const message = { conversationKey: "oc_delta", eventId: "evt-delta" };

  // The real event shape (docs/runtime/model-call.md §4.1): the payload field is
  // `delta`, not `content`. Reading the wrong one produced a silent empty turn.
  await projector.push(message, { type: "token", delta: "你好" });
  await projector.push(message, { type: "token", delta: "，世界" });
  await projector.push(message, { type: "done" });

  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].text, "你好", "the first token opens the card");
  assert.equal(api.patches.at(-1).text, "你好，世界", "the terminal event flushes the full text");
});

test("a non-streaming turn still lands its final message", async () => {
  const api = fakeApi();
  const projector = createProjector({ api, throttleMs: 1000, now: () => 0 });
  const message = { conversationKey: "oc_final", eventId: "evt-final" };

  await projector.push(message, { type: "done", message: { role: "assistant", content: "整段回复" } });

  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].text, "整段回复");
});
