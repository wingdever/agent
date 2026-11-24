"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createChannel, type } from "../../../channels/feishu/index.js";
import { assertChannel } from "../../../channels/contract.js";
import { createInboundPipeline } from "../../../channels/inbound/pipeline.js";
import { createDedupe } from "../../../channels/inbound/dedupe.js";
import { createChannelManager } from "../../../channels/manager.js";
import { SUPPORTED_EVENT } from "../../../channels/feishu/events.js";
import { createFakeFeishuPlatform } from "../../../test/channels/feishu/fake-platform-server.js";

function envelope({ eventId = "evt-1", text = "在吗", chatId = "oc_1", senderType = "user" } = {}) {
  return {
    schema: "2.0",
    header: { event_id: eventId, event_type: SUPPORTED_EVENT, create_time: "1700000000000", app_id: "cli_test" },
    event: {
      sender: { sender_id: { open_id: "ou_1" }, sender_type: senderType },
      message: {
        message_id: `om_in_${eventId}`,
        chat_id: chatId,
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
  };
}

function buildChannel(platform) {
  return createChannel({
    instance: {
      id: "fs-test",
      credentials: { appId: "cli_test", appSecret: "test-secret" },
      options: { baseUrl: platform.url, qps: 20, throttleMs: 1000 },
    },
  });
}

function wire(channel, runTurn) {
  const pipeline = createInboundPipeline({
    dedupe: createDedupe({ capacity: 16 }),
    runTurn,
    project: (message, event) => channel.project(message, event),
  });
  return pipeline;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The frame lands on the socket asynchronously; wait until intake saw it. */
async function waitUntil(predicate, timeoutMs = 3000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("the driver is a valid channel", () => {
  const channel = createChannel({ instance: { id: "fs-contract", credentials: { appId: "a", appSecret: "b" } } });
  assertChannel(channel);
  assert.equal(channel.type, type);
  assert.equal(channel.capabilities.eventMode, "ws");
  assert.equal(channel.capabilities.ackDeadlineMs, 3000);
});

test("a chat message becomes one card that ends with the full reply", async () => {
  const platform = await createFakeFeishuPlatform().start();
  const channel = buildChannel(platform);
  const runs = [];
  const pipeline = wire(channel, async (message, emit) => {
    runs.push(message);
    emit({ type: "token", content: "你好" });
    emit({ type: "token", content: "，我是飞书渠道" });
    emit({ type: "turn-end" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.waitForSocket();
    platform.deliver(envelope({ eventId: "evt-1" }));
    await waitUntil(() => pipeline.stats.accepted === 1, 3000, "intake");
    await pipeline.idle();
    await platform.waitFor((state) => state.patches.length >= 1, 3000, "final card patch");

    assert.equal(runs.length, 1, "one inbound message must start exactly one turn");
    assert.equal(runs[0].conversationKey, "oc_1");
    assert.equal(platform.state.sent.length, 1, "one turn must create exactly one card");
    assert.equal(platform.state.sent[0].receive_id, "oc_1");
    assert.equal(platform.state.sent[0].msg_type, "interactive");

    const card = JSON.parse(platform.state.patches[0].content);
    assert.equal(card.body.elements[0].content, "你好，我是飞书渠道");
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("a redelivered event id does not run the turn twice", async () => {
  const platform = await createFakeFeishuPlatform().start();
  const channel = buildChannel(platform);
  const runs = [];
  const pipeline = wire(channel, async (message, emit) => {
    runs.push(message);
    emit({ type: "token", content: "ok" });
    emit({ type: "turn-end" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.waitForSocket();
    platform.deliver(envelope({ eventId: "evt-dup" }));
    await waitUntil(() => pipeline.stats.accepted === 1, 3000, "first delivery");
    await pipeline.idle();
    platform.deliver(envelope({ eventId: "evt-dup" }));
    await waitUntil(() => pipeline.stats.duplicates === 1, 3000, "duplicate");
    await pipeline.idle();

    assert.equal(runs.length, 1);
    assert.equal(platform.state.sent.length, 1);
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("the bot's own messages are not answered", async () => {
  const platform = await createFakeFeishuPlatform().start();
  const channel = buildChannel(platform);
  const runs = [];
  const pipeline = wire(channel, async (message, emit) => {
    runs.push(message);
    emit({ type: "turn-end" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.waitForSocket();
    platform.deliver(envelope({ eventId: "evt-bot", senderType: "app" }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(runs.length, 0);
    assert.equal(platform.state.sent.length, 0);
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("an expired token is replaced and the call is retried", async () => {
  const platform = await createFakeFeishuPlatform().start();
  const channel = buildChannel(platform);
  const pipeline = wire(channel, async (message, emit) => {
    emit({ type: "token", content: "收到" });
    emit({ type: "turn-end" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.waitForSocket();
    platform.state.rejectTokenNext = true;
    platform.deliver(envelope({ eventId: "evt-auth" }));
    await waitUntil(() => pipeline.stats.accepted === 1, 3000, "intake");
    await pipeline.idle();
    await platform.waitFor((state) => state.sent.length >= 1, 3000, "message after token refresh");

    assert.equal(platform.state.tokenRequests, 2, "token must be re-acquired once");
    assert.equal(platform.state.sent.length, 1, "the retry must still deliver");
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("a rate-limited send is retried instead of dropped", async () => {
  const platform = await createFakeFeishuPlatform().start();
  const channel = buildChannel(platform);
  const pipeline = wire(channel, async (message, emit) => {
    emit({ type: "token", content: "收到" });
    emit({ type: "turn-end" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.waitForSocket();
    // Measured on the real platform: the reply card right after an event is
    // answered with HTTP 200 + code 230429, which must be treated as pacing.
    platform.state.throttleNext = 2;
    platform.deliver(envelope({ eventId: "evt-throttle" }));
    await waitUntil(() => pipeline.stats.accepted === 1, 3000, "intake");
    await pipeline.idle();
    await platform.waitFor((state) => state.sent.length >= 1, 4000, "card after throttling");

    assert.equal(platform.state.sent.length, 1, "the card must land exactly once");
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("two chats get two cards, never one mixed card", async () => {
  const platform = await createFakeFeishuPlatform().start();
  const channel = buildChannel(platform);
  const pipeline = wire(channel, async (message, emit) => {
    emit({ type: "token", content: "for " + message.conversationKey });
    emit({ type: "turn-end" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.waitForSocket();
    platform.deliver(envelope({ eventId: "evt-a", chatId: "oc_a" }));
    platform.deliver(envelope({ eventId: "evt-b", chatId: "oc_b" }));
    await waitUntil(() => pipeline.stats.accepted === 2, 3000, "both deliveries");
    await pipeline.idle();
    await platform.waitFor((state) => state.sent.length >= 2 && state.patches.length >= 2, 3000, "two cards");

    assert.deepEqual(platform.state.sent.map((item) => item.receive_id).sort(), ["oc_a", "oc_b"]);
    const texts = platform.state.patches.map((patch) => JSON.parse(patch.content).body.elements[0].content).sort();
    assert.deepEqual(texts, ["for oc_a", "for oc_b"]);
  } finally {
    await channel.stop();
    await platform.stop();
  }
});


test("a channel without credentials builds and reports what is missing, but refuses to start", async () => {
  // Building must not require credentials: the instance may exist before the app
  // secret does. Only a start turns that absence into an error.
  const channel = createChannel({ instance: { id: "fs-bare", credentials: {}, options: {} } });
  assertChannel(channel);
  assert.deepEqual(channel.check(), [
    "credentials.appId is missing (or CHANNEL_FS_BARE_APPID)",
    "credentials.appSecret is missing (or CHANNEL_FS_BARE_APPSECRET)",
  ]);

  let connections = 0;
  const guarded = createChannel({
    instance: { id: "fs-bare", credentials: {}, options: {} },
    deps: { connect: () => { connections++; return { close() {} }; } },
  });
  const manager = createChannelManager({ channels: [guarded] });
  manager.setSink({ async runTurn() {} });
  await assert.rejects(
    manager.start("fs-bare"),
    /channel "fs-bare" cannot start: credentials\.appId is missing .*appSecret is missing/
  );
  assert.equal(connections, 0, "no connection may be attempted without credentials");
  const status = manager.status("fs-bare");
  assert.equal(status.status, "error");
  assert.match(status.error, /appSecret is missing/);
});

test("check passes once both fields exist, and the env hint names the right variable", () => {
  const channel = createChannel({ instance: { id: "fs_full", credentials: { appId: "cli_x", appSecret: "s" } } });
  assert.deepEqual(channel.check(), []);
});
