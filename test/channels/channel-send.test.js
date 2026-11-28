"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import channelSend from "../../lib/channel-send/index.js";
import runNode from "../../core/loops/nodes/channel-send/run.js";

const { sendToChannel, endpointFor, DEFAULT_PATH } = channelSend;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("endpointFor appends /proactive and strips trailing slashes", () => {
  assert.equal(endpointFor("http://127.0.0.1:8080"), `http://127.0.0.1:8080${DEFAULT_PATH}`);
  assert.equal(endpointFor("http://127.0.0.1:8080/"), `http://127.0.0.1:8080${DEFAULT_PATH}`);
});

test("sendToChannel POSTs a validated payload to the callback endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse({ ok: true });
  };
  const result = await sendToChannel({
    endpoint: "http://127.0.0.1:9000",
    instanceId: "qq-bot",
    conversationKey: "G1",
    text: "hello",
    senderId: "U1",
    recvType: "user",
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9000/proactive");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, {
    instanceId: "qq-bot",
    conversationKey: "G1",
    text: "hello",
    senderId: "U1",
    recvType: "user",
  });
});

test("sendToChannel validates required fields before fetching", async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; };
  await assert.rejects(() => sendToChannel({ endpoint: "http://x", instanceId: "", conversationKey: "G", text: "t", fetchImpl }), /instanceId/);
  await assert.rejects(() => sendToChannel({ endpoint: "http://x", instanceId: "i", conversationKey: "", text: "t", fetchImpl }), /conversationKey/);
  await assert.rejects(() => sendToChannel({ endpoint: "http://x", instanceId: "i", conversationKey: "G", text: "", fetchImpl }), /text/);
  assert.equal(fetched, false);
});

test("sendToChannel throws on http failure and on ok:false payload", async () => {
  await assert.rejects(
    () => sendToChannel({ endpoint: "http://x", instanceId: "i", conversationKey: "G", text: "t", fetchImpl: async () => jsonResponse({}, 500) }),
    /http 500/
  );
  await assert.rejects(
    () => sendToChannel({ endpoint: "http://x", instanceId: "i", conversationKey: "G", text: "t", fetchImpl: async () => jsonResponse({ ok: false, error: "unknown channel" }) }),
    /unknown channel/
  );
});

test("sendToChannel sends the bearer token and returns a sent-but-unacked receipt", async () => {
  const calls = [];
  const receipt = await sendToChannel({
    endpoint: "http://x", instanceId: "i", conversationKey: "G", text: "t", token: "s3cret",
    fetchImpl: async (url, init) => {
      calls.push(init);
      return jsonResponse({ ok: false, sent: true, acked: false, error: "ack store offline" });
    },
  });
  assert.equal(calls[0].headers.Authorization, "Bearer s3cret");
  assert.equal(receipt.sent, true);
  assert.equal(receipt.acked, false);
});

function nodeCtx(delivery, events, fetchImpl) {
  return {
    channelDelivery: delivery,
    step: { response: { content: "model answer" } },
    emit: (e) => events.push(e),
    fetchImpl,
  };
}

test("channel-send node posts injected delivery and emits start/done", async () => {
  const events = [];
  const calls = [];
  const ctx = nodeCtx(
    { endpoint: "http://127.0.0.1:9000", instanceId: "qq-bot", conversationKey: "G1", text: "scheduled" },
    events,
    async (url, init) => { calls.push(JSON.parse(init.body)); return jsonResponse({ ok: true }); }
  );
  const result = await runNode({}, ctx);
  assert.equal(result.next, "decide-next");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "scheduled");
  assert.deepEqual(events.map((e) => e.phase), ["start", "done"]);
});

test("channel-send node resolves a function text from the model response", async () => {
  const events = [];
  const calls = [];
  const ctx = nodeCtx(
    {
      endpoint: "http://x",
      instanceId: "qq-bot",
      conversationKey: "G1",
      text: (response) => response.content,
    },
    events,
    async (url, init) => { calls.push(JSON.parse(init.body)); return jsonResponse({ ok: true }); }
  );
  await runNode({}, ctx);
  assert.equal(calls[0].text, "model answer");
});

test("channel-send node is a no-op without delivery parameters", async () => {
  const events = [];
  let fetched = false;
  const ctx = nodeCtx(null, events, async () => { fetched = true; });
  const result = await runNode({ pass: true }, ctx);
  assert.deepEqual(result, { output: { pass: true }, next: "decide-next" });
  assert.equal(fetched, false);
  assert.equal(events.length, 0);
});

test("channel-send node emits an error event but does not throw on send failure", async () => {
  const events = [];
  const delivery = { endpoint: "http://x", instanceId: "qq-bot", conversationKey: "G1", text: "t" };
  const ctx2 = nodeCtx(delivery, events, async () => jsonResponse({ ok: false, error: "boom" }));
  const result = await runNode({}, ctx2);
  assert.equal(result.next, "decide-next");
  assert.deepEqual(events.map((e) => e.phase), ["start", "error"]);
  assert.match(events[1].error, /boom/);
  assert.equal(delivery.deliveryError.includes("boom"), true);
});
