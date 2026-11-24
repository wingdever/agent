"use strict";

import test from "node:test";
import assert from "assert/strict";

import { createChannel } from "../../../channels/yunhu/index.js";
import { textContent } from "../../../channels/yunhu/api.js";
import { parseEvent } from "../../../channels/yunhu/events.js";
import { assertChannel } from "../../../channels/contract.js";
import { createInboundPipeline } from "../../../channels/inbound/pipeline.js";
import { createDedupe } from "../../../channels/inbound/dedupe.js";
import { createChannelManager } from "../../../channels/manager.js";
import { createFakeYunhuPlatform, fakeEnvelope } from "../../../test/channels/yunhu/fake-platform-server.js";

function buildChannel(platform, overrides = {}) {
  return createChannel({
    instance: {
      id: "yh-test",
      credentials: { botId: platform.botId, token: platform.token },
      options: { mode: "webhook", baseUrl: platform.url, port: 0, path: "/webhook", throttleMs: 0, ...(overrides.options || {}) },
      ...(overrides.id ? { id: overrides.id } : {}),
    },
  });
}

/** A stand-in for a WebSocket that the test drives by hand. */
function fakeSocket() {
  const handlers = new Map();
  return {
    closed: false,
    addEventListener(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    emit(name, arg) {
      for (const fn of handlers.get(name) || []) fn(arg);
    },
    close() {
      this.closed = true;
      this.emit("close", { code: 1005 });
    },
  };
}

function wire(channel, runTurn) {
  const pipeline = createInboundPipeline({
    dedupe: createDedupe({ capacity: 16 }),
    runTurn,
    project: (message, event) => channel.project(message, event),
  });
  return pipeline;
}

test("the driver defaults to the long connection and validates as a channel", () => {
  const channel = createChannel({ instance: { id: "yh-contract", credentials: { botId: "b1", token: "t1" } } });
  assertChannel(channel);
  // Long connection is the default because it needs no public endpoint. The console
  // makes the two modes exclusive, so a driver that claims both would lie.
  assert.equal(channel.capabilities.eventMode, "ws");
  assert.equal(channel.capabilities.streaming, true);
});

test("webhook mode is still selectable and then owns an HTTP listener", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform);
  try {
    await channel.start(async () => ({ accepted: true }));
    assert.equal(channel.mode, "webhook");
    assert.equal(channel.capabilities.eventMode, "webhook");
    assert.match(channel.webhookUrl, /^http:\/\/127\.0\.0\.1:\d+\/webhook$/);
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("a real captured frame parses the way the live gateway sends it", () => {
  // Verbatim from wss://ws.jwzhd.com/subscribe: a mentioned group message, where
  // `content.at` is the list of mentioned user ids and the text keeps the "@ami" prefix.
  const envelope = {
    version: "1.0",
    header: { eventId: "ace9f3e87af94a50be5b620622f6854d", eventType: "message.receive.normal", eventTime: 1795369371122 },
    event: {
      sender: { senderId: "9997915", senderType: "user", senderUserLevel: "owner", senderNickname: "魏宁", senderAvatarUrl: "https://chat-img.jwznb.com/x.jpg" },
      chat: { chatId: "846015667", chatType: "group" },
      message: {
        msgId: "64de6c870c42440c8feb69a5e7e77183",
        parentId: "",
        sendTime: 1795368921247,
        chatId: "846015667",
        chatType: "group",
        contentType: "text",
        content: { text: "@ami ​看看", at: ["83683850"] },
        instructionId: 0,
        instructionName: "",
        commandId: 0,
        commandName: "",
      },
    },
  };
  const message = parseEvent(envelope, { type: "yunhu", instanceId: "yh-live", botId: "83683850" });
  assert.equal(message.conversationKey, "846015667");
  assert.equal(message.recvType, "group");
  assert.equal(message.replyTo, "64de6c870c42440c8feb69a5e7e77183");
  assert.equal(message.messages[0].content, "看看", "@ami prefix stripped");
  assert.equal(message.mentioned, true);
});

test("the socket carries a turn end to end and reconnects after a close", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const sockets = [];
  const scheduled = [];
  const channel = createChannel({
    instance: { id: "yh-ws", credentials: { botId: platform.botId, token: platform.token }, options: { baseUrl: platform.url, throttleMs: 0 } },
    deps: { dial: () => { const s = fakeSocket(); sockets.push(s); return s; }, schedule: (fn, ms) => scheduled.push({ fn, ms }) },
  });

  const runs = [];
  try {
    const started = channel.start(async (message) => { runs.push(message); });
    sockets[0].emit("open");
    await started;

    sockets[0].emit("message", { data: JSON.stringify(fakeEnvelope({ text: "在吗" })) });
    // The handler returns immediately (that is the ack); the turn itself is the
    // sink's business, so wait on the pipeline, not the socket.
    // A control frame without eventType must be ignored, not counted as an event.
    sockets[0].emit("message", { data: "{\"type\":\"pong\"}" });
    assert.equal(runs.length, 1);
    assert.equal(channel.stats.frames, 1);
    assert.equal(channel.stats.ignored, 1);

    sockets[0].emit("close", { code: 1006 });
    assert.equal(scheduled.length >= 1, true, "a closed socket must be scheduled for redial");
    assert.equal(channel.stats.reconnects, 1);
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("credentials are only required at start, and the message names the env variable", async () => {
  const bare = createChannel({ instance: { id: "yh-bare", credentials: {} } });
  assertChannel(bare);
  assert.deepEqual(bare.check(), [
    "credentials.botId is missing (or CHANNEL_YH_BARE_BOTID)",
    "credentials.token is missing (or CHANNEL_YH_BARE_TOKEN)",
  ]);

  const manager = createChannelManager({ channels: [bare] });
  manager.setSink({ async runTurn() {} });
  await assert.rejects(manager.start("yh-bare"), /channel "yh-bare" cannot start: credentials\.botId is missing/);
  // No listener may be opened without credentials.
  assert.equal(bare.webhookUrl, "");
});

test("a webhook message becomes one outbound message on the bot API", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform);
  const runs = [];
  const pipeline = wire(channel, async (message, emit) => {
    runs.push(message);
    emit({ type: "final", content: "我在，请说" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    assert.match(channel.webhookUrl, /^http:\/\/127\.0\.0\.1:\d+\/webhook$/);

    const acked = await platform.deliver(channel.webhookUrl, fakeEnvelope({ recvId: "u_1", text: "在吗" }));
    assert.equal(acked.status, 200);

    await pipeline.idle();
    assert.equal(runs.length, 1);
    assert.equal(platform.state.sends.length, 1);
    const sent = platform.state.sends[0];
    assert.equal(sent.recvId, "u_1");
    assert.equal(sent.recvType, "user");
    assert.equal(sent.contentType, "text");
    assert.equal(sent.content.text, "我在，请说");
    // The reply quotes the inbound message, so a group with several bots stays readable.
    assert.equal(sent.parentId, "msg_1");
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("a group message replies to the chat, never to the person who spoke", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform);
  const pipeline = wire(channel, async (_message, emit) => emit({ type: "final", content: "收到" }));

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.deliver(channel.webhookUrl, fakeEnvelope({ recvId: "g_100", recvType: "group", text: "开会了", at: [platform.botId] }));
    await pipeline.idle();

    const sent = platform.state.sends[0];
    assert.equal(sent.recvType, "group");
    assert.equal(sent.recvId, "g_100", "a group answer must not be sent to the speaker id");
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("a group message survives the mention gate only when it is aimed at the bot", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform);
  const runs = [];
  const pipeline = wire(channel, async (message, emit) => {
    runs.push(message);
    emit({ type: "final", content: "在" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));

    // The platform pushes every group message; a plain one is not ours to answer.
    await platform.deliver(channel.webhookUrl, fakeEnvelope({ recvId: "g_200", recvType: "group", text: "@ami 看看" }));
    // An instruction event carries instructionId/Name and always counts as aimed at us.
    const instruction = fakeEnvelope({ eventId: "evt_i", recvId: "g_200", recvType: "group", text: "/help", eventType: "message.receive.instruction" });
    await platform.deliver(channel.webhookUrl, instruction);
    // A real mention mentions us by id.
    await platform.deliver(channel.webhookUrl, fakeEnvelope({ eventId: "evt_m", msgId: "msg_m", recvId: "g_200", recvType: "group", text: "@ami ​看看", at: [platform.botId] }));
    // A direct chat needs no mention at all.
    await platform.deliver(channel.webhookUrl, fakeEnvelope({ eventId: "evt_d", msgId: "msg_d", recvId: "u_7", recvType: "user", text: "在吗" }));

    await pipeline.idle();
    assert.equal(runs.length, 3, "plain group message dropped, instruction/mention/direct pass");
    assert.equal(runs[0].instruction, true);
    assert.equal(runs[1].mentioned, true);
    assert.equal(runs[1].messages[0].content, "看看", "the @nickname prefix is stripped");
    assert.equal(runs[2].recvType, "user");
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("the bot ignores its own messages and non-text events", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform);
  const runs = [];
  const pipeline = wire(channel, async (message, emit) => {
    runs.push(message);
    emit({ type: "final", content: "x" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    // senderId === botId: this is the bot's own echo.
    await platform.deliver(channel.webhookUrl, fakeEnvelope({ recvId: platform.botId, text: "自己发的" }));

    const imagePayload = fakeEnvelope({ text: "" });
    imagePayload.event.message.contentType = "image";
    imagePayload.event.message.content = { imageKey: "k" };
    await platform.deliver(channel.webhookUrl, imagePayload);

    await pipeline.idle();
    assert.equal(runs.length, 0);
    assert.equal(platform.state.sends.length, 0);
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("a re-delivered event id runs one turn and sends one message", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform);
  const runs = [];
  const pipeline = wire(channel, async (message, emit) => {
    runs.push(message);
    emit({ type: "final", content: "只答一次" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    const envelope = fakeEnvelope({ eventId: "evt_dup", msgId: "msg_dup" });
    await platform.deliver(channel.webhookUrl, envelope);
    await platform.deliver(channel.webhookUrl, envelope);
    await pipeline.idle();

    assert.equal(runs.length, 1);
    assert.equal(platform.state.sends.length, 1);
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("partial text edits the same message instead of sending another one", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform, { options: { baseUrl: platform.url, port: 0, throttleMs: 0 } });
  const pipeline = wire(channel, async (_message, emit) => {
    emit({ type: "token", content: "第一段" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit({ type: "token", content: "，第二段" });
    emit({ type: "final", content: "第一段，第二段" });
  });

  try {
    await channel.start((message) => pipeline.handle(message));
    await platform.deliver(channel.webhookUrl, fakeEnvelope({ text: "讲讲" }));
    await pipeline.idle();

    assert.equal(platform.state.sends.length, 1, "one reply, not one per token");
    assert.ok(platform.state.edits.length >= 1, "later text updates the same message");
    const lastEdit = platform.state.edits[platform.state.edits.length - 1];
    assert.equal(lastEdit.msgId, platform.state.sends[0].msgId);
    assert.equal(lastEdit.content.text, "第一段，第二段");
  } finally {
    await channel.stop();
    await platform.stop();
  }
});

test("a send exposes the new id under messageInfo.msgId", async () => {
  // The first version of this driver read `data.msgId`, which the live gateway
  // never returns -- the id lives at `data.messageInfo.msgId`.
  const platform = await createFakeYunhuPlatform().start();
  const channel = buildChannel(platform);
  try {
    const result = await channel.api.send({ recvId: "u_1", recvType: "user", content: textContent("x") });
    assert.match(result.messageInfo.msgId, /^msg_/);
    assert.equal(result.messageInfo.recvType, "user");
  } finally {
    await platform.stop();
  }
});

test("an edit without recvId is refused before it reaches the gateway", () => {
  const channel = createChannel({ instance: { id: "yh-edit", credentials: { botId: "b", token: "t" } } });
  assert.throws(
    () => channel.api.edit({ msgId: "msg_1", content: textContent("x") }),
    /yunhu edit needs recvId and recvType/
  );
});

test("an invalid bot token surfaces as an auth error, not as success", async () => {
  const platform = await createFakeYunhuPlatform().start();
  const bad = createChannel({
    instance: { id: "yh-bad", credentials: { botId: platform.botId, token: "wrong" }, options: { baseUrl: platform.url } },
  });

  await assert.rejects(
    bad.api.send({ recvId: "u_1", recvType: "user", contentType: "text", content: { text: "hi" } }),
    /yunhu auth rejected: 非法token/
  );
  assert.equal(platform.state.rejected, 1);
  await platform.stop();
});

test("the webhook endpoint rejects foreign paths, verbs and a wrong secret", async () => {
  const channel = createChannel({
    instance: { id: "yh-guard", credentials: { botId: "b", token: "t1" }, options: { mode: "webhook", secret: "s3cret", port: 0 } },
  });
  const seen = [];
  try {
    await channel.start((message) => seen.push(message));

    const wrongPath = await fetch(channel.webhookUrl.replace("/webhook", "/other"), { method: "POST", body: "{}" });
    assert.equal(wrongPath.status, 404);

    const noSecret = await fetch(channel.webhookUrl, { method: "POST", body: "{}" });
    assert.equal(noSecret.status, 403);

    const getInstead = await fetch(`${channel.webhookUrl}?secret=s3cret`);
    assert.equal(getInstead.status, 405);

    const ok = await fetch(`${channel.webhookUrl}?secret=s3cret`, {
      method: "POST",
      body: JSON.stringify(fakeEnvelope({ text: "进来" })),
    });
    assert.equal(ok.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(channel.stats.rejected, 3); // wrong path, wrong verb, missing secret
  } finally {
    await channel.stop();
  }
});
