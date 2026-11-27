"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannelCallback } from "../../channels/callback.js";

function fakeChannel() {
  const projects = [];
  return {
    type: "qq",
    instanceId: "qq-bot",
    projects,
    async project(message, event) {
      projects.push({ message, event });
    },
  };
}

test("callback validates required fields before touching a channel", async () => {
  const channel = fakeChannel();
  const callback = createChannelCallback({ lookupChannel: () => channel });
  assert.deepEqual(await callback.deliver({}), {
    ok: false,
    error: "instanceId, conversationKey and text are required",
  });
  assert.equal(channel.projects.length, 0);
});

test("callback rejects an unknown instance without projecting", async () => {
  const callback = createChannelCallback({ lookupChannel: () => null });
  const result = await callback.deliver({
    instanceId: "missing",
    conversationKey: "G1",
    text: "hello",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown channel instance/);
});

test("callback projects a proactive text as a final event with no passive reply id", async () => {
  const channel = fakeChannel();
  const delivered = [];
  const callback = createChannelCallback({
    lookupChannel: () => channel,
    onDeliver: async (payload) => delivered.push(payload),
  });
  const result = await callback.deliver({
    instanceId: "qq-bot",
    conversationKey: "G_ROOM",
    senderId: "U_1",
    recvType: "group",
    text: "scheduled answer",
    inputSource: "schedule",
  });
  assert.equal(result.ok, true);
  assert.equal(channel.projects.length, 1);
  const { message, event } = channel.projects[0];
  assert.equal(event.type, "final");
  assert.equal(event.content, "scheduled answer");
  assert.equal(message.replyTo, "", "proactive messages carry no passive reply id");
  assert.equal(message.conversationKey, "G_ROOM");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].inputSource, "schedule");
});

test("callback HTTP endpoint routes POST /proactive and rejects other paths", async () => {
  const channel = fakeChannel();
  const callback = createChannelCallback({ lookupChannel: () => channel });
  const addr = await callback.listen();
  try {
    const ok = await fetch(addr.sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "qq-bot", conversationKey: "G_HTTP", text: "via http" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(channel.projects[0].event.content, "via http");

    const missing = await fetch(`http://${addr.host}:${addr.port}/other`, { method: "POST" });
    assert.equal(missing.status, 404);
    assert.equal(channel.projects.length, 1);

    const bad = await fetch(addr.sendUrl, { method: "POST", body: "not json" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).ok, false);
  } finally {
    await callback.close();
  }
});

test("callback reports a project failure as a non-ok result", async () => {
  const channel = fakeChannel();
  channel.project = async () => { throw new Error("send failed"); };
  const callback = createChannelCallback({ lookupChannel: () => channel, log: () => {} });
  const result = await callback.deliver({ instanceId: "qq-bot", conversationKey: "G1", text: "x" });
  assert.equal(result.ok, false);
  assert.match(result.error, /send failed/);
});

