"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannel } from "../../../channels/qq/index.js";

function fakeFetch(sends) {
  const impl = async (url, init = {}) => {
    if (url.includes("bots.qq.com/app/getAppAccessToken")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: "7200" }) };
    }
    if (url.includes("/v2/")) sends.push({ url, body: JSON.parse(init.body || "{}") });
    return { ok: true, status: 200, json: async () => ({ id: "sent" }) };
  };
  return impl;
}

function newDriver(sends) {
  return createChannel({
    instance: {
      id: "qq-test",
      credentials: { appId: "1", appSecret: "s", botId: "bot" },
      options: { qps: 0 },
    },
    deps: { fetch: fakeFetch(sends) },
  });
}

function inbound(replyTo) {
  return { recvType: "group", conversationKey: "G1", replyTo, senderId: "U1", messages: [] };
}

async function sendText(driver, replyTo, text) {
  await driver.project(inbound(replyTo), { type: "final", content: text });
}

function passiveSends(sends) {
  return sends.filter((s) => s.body.msg_id).map((s) => `${s.body.msg_id}:${s.body.msg_seq}`);
}

test("normal turn: final reply uses msg_seq=1 then clears the key", async () => {
  const sends = [];
  const driver = newDriver(sends);
  await sendText(driver, "m1", "first");
  assert.deepEqual(passiveSends(sends), ["m1:1"]);

  // A second turn answering the same inbound reuses seq 1 — acceptable only
  // if the first reply's quota window has passed or the platform tolerates it.
  await sendText(driver, "m1", "second");
  assert.deepEqual(passiveSends(sends), ["m1:1", "m1:1"], "key was cleared after final");
});

test("multiple outbound for one inbound increments seq (card then final)", async () => {
  const sends = [];
  const driver = newDriver(sends);
  await driver.project(inbound("m2"), {
    type: "approval-request", id: 1, name: "Bash", arguments: {}, permission: "ask",
  });
  await sendText(driver, "m2", "after card");
  assert.deepEqual(passiveSends(sends), ["m2:1", "m2:2"], "card=1, final=2");
});

test("restart resets seq: card before restart and final after collide on m3:1", async () => {
  const sends = [];
  const before = newDriver(sends);
  await before.project(inbound("m3"), {
    type: "approval-request", id: 1, name: "Bash", arguments: {}, permission: "ask",
  });
  assert.deepEqual(passiveSends(sends), ["m3:1"]);

  // Simulate process restart: a fresh driver with an empty replySeq map.
  const after = newDriver(sends);
  await sendText(after, "m3", "after restart");
  const seqs = passiveSends(sends);
  assert.deepEqual(seqs, ["m3:1", "m3:1"], "seq reset to 1 — duplicate msg_id+msg_seq");
});

test("core-pull single outbound per turn never reaches seq>1, so restart is harmless", async () => {
  const sends = [];
  // In core-pull, channel-send emits only {type:"final"}. One outbound per turn.
  const before = newDriver(sends);
  await sendText(before, "m4", "before restart");
  const after = newDriver(sends);
  await sendText(after, "m5", "after restart"); // different inbound message
  assert.deepEqual(passiveSends(sends), ["m4:1", "m5:1"], "each inbound replied once");
});
