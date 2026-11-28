"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import listenLib from "../../lib/channel-listen/index.js";
import listenNode, { attach } from "../../core/loops/builtins/channel-listen/run.js";

const { createChannelListener, stopAllListeners, parseSseChunk } = listenLib;

test("parseSseChunk splits frames and carries partial data", () => {
  let parsed = parseSseChunk('data: {"eventId":"1"}\n\ndata: {"eventId"');
  assert.deepEqual(parsed.frames, ['{"eventId":"1"}']);
  assert.equal(parsed.carry, 'data: {"eventId"');
  parsed = parseSseChunk(':"2"}\n\n', parsed.carry);
  assert.deepEqual(parsed.frames, ['{"eventId":"2"}']);
  assert.equal(parsed.carry, "");
});

test("createChannelListener is idempotent per endpoint+instance", () => {
  stopAllListeners();
  const a = createChannelListener({ endpoint: "http://x", instanceId: "bot", onMessage: () => {} });
  const b = createChannelListener({ endpoint: "http://x", instanceId: "bot", onMessage: () => {} });
  assert.equal(a, b);
  const c = createChannelListener({ endpoint: "http://x", instanceId: "other", onMessage: () => {} });
  assert.notEqual(a, c);
  stopAllListeners();
});

test("listener parses SSE frames and skips snapshots, passing messages to onMessage", async () => {
  stopAllListeners();
  const seen = [];
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"snapshot","count":0}\n\n' +
          'data: {"type":"message","eventId":"m1","instanceId":"bot","messages":[{"role":"user","content":"hi"}]}\n\n' +
          'data: [DONE]\n\n'
        ));
        controller.close();
      },
    });
    return { ok: true, status: 200, body };
  };
  const listener = createChannelListener({
    endpoint: "http://svc", instanceId: "bot", onMessage: (m) => seen.push(m), fetchImpl, schedule: () => {},
  });
  listener.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetched[0], "http://svc/messages/subscribe?instanceId=bot");
  assert.equal(seen.length, 1, "snapshot skipped");
  assert.equal(seen[0].eventId, "m1");
  listener.stop();
  stopAllListeners();
});

test("channel-listen run injects ctx.channelMessage into the turn input", async () => {
  const message = {
    eventId: "e1", conversationKey: "G1",
    messages: [{ role: "user", content: "hello" }],
  };
  const events = [];
  const ctx = { input: { messages: [] }, emit: (e) => events.push(e), channelMessage: message };
  const result = await listenNode({ pass: true }, ctx);
  assert.deepEqual(result, { output: { pass: true } });
  assert.equal(ctx.input.messages.length, 1);
  assert.equal(ctx.input.messages[0].content, "hello");
  assert.equal(ctx.channelMessages.length, 1);
  assert.equal(events[0].eventId, "e1");
});

test("channel-listen run is a no-op without a delivered message", async () => {
  const ctx = { input: { messages: [] } };
  const result = await listenNode({ pass: true }, ctx);
  assert.deepEqual(result, { output: { pass: true } });
  assert.equal(ctx.input.messages.length, 0);
});

test("attach opens a listener and routes each message into a turn", async () => {
  stopAllListeners();
  const turns = [];
  const core = {
    agent: { chat: async (ctx) => { turns.push(ctx); return { ok: true }; } },
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"message","eventId":"m1","instanceId":"bot","type":"qq","conversationKey":"G1","messages":[{"role":"user","content":"hi"}]}\n\n'
        ));
        controller.close();
      },
    });
    return { ok: true, status: 200, body };
  };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", fetchImpl, schedule: () => {}, log: () => {},
  });
  assert.ok(listener, "attach returns a listener");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].entryNode, "builtin.channel-listen");
  assert.equal(turns[0].channelMessage.eventId, "m1");
  assert.deepEqual(turns[0].channelDelivery, {
    endpoint: "http://svc",
    instanceId: "bot",
    conversationKey: "G1",
    senderId: undefined,
    recvType: undefined,
    ackEventId: "m1",
  });
  listener.stop();
  stopAllListeners();
});

test("attach injects prior history as contextMessages into the turn", async () => {
  stopAllListeners();
  const turns = [];
  const core = {
    agent: { chat: async (ctx) => { turns.push(ctx); return { ok: true }; } },
  };
  const prior = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ];
  const historyReader = { contextMessages: async () => prior, close: () => {} };
  const fetchImpl = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"type":"message","eventId":"m2","instanceId":"bot","type":"qq","conversationKey":"G1","messages":[{"role":"user","content":"new"}]}\n\n'
        ));
        c.close();
      },
    }),
  });
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", historyReader, fetchImpl, schedule: () => {}, log: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].contextMessages, prior);
  listener.closeHistory();
  listener.stop();
  stopAllListeners();
});

test("entry phase initializes request.messages so model-call can set the header", async () => {
  const message = {
    eventId: "e3", conversationKey: "G1",
    messages: [{ role: "user", content: "hello" }],
  };
  const ctx = {
    input: { messages: [] },
    system: "system prompt",
    request: { messages: null, header: null },
    emit: () => {},
    channelMessage: message,
  };
  await listenNode({ pass: true }, ctx);
  assert.ok(Array.isArray(ctx.request.messages), "request.messages initialized");
  assert.equal(ctx.request.messages[0].role, "system");
  assert.equal(ctx.request.messages[0].content, "system prompt");
  assert.equal(ctx.request.messages[1].content, "hello");
});

test("attach reports failure via /proactive with status=failed", async () => {
  stopAllListeners();
  const posts = [];
  const core = {
    agent: { chat: async () => ({ error: "model failed", stopReason: "failed" }) },
  };
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/proactive") && init && init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return {
      ok: true, status: 200,
      body: new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"type":"message","eventId":"fail-1","instanceId":"bot","messages":[{"role":"user","content":"x"}]}\n\n'
        ));
        c.close();
      } }),
    };
  };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", fetchImpl, schedule: () => {}, log: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].status, "failed");
  assert.equal(posts[0].ackEventId, "fail-1");
  listener.stop();
  stopAllListeners();
});

test("attach passes ackEventId in channelDelivery for a successful turn", async () => {
  stopAllListeners();
  let seenCtx = null;
  const core = { agent: { chat: async (ctx) => { seenCtx = ctx; return { role: "assistant", content: "ok" }; } } };
  const fetchImpl = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(
        'data: {"type":"message","eventId":"ok-1","instanceId":"bot","messages":[{"role":"user","content":"x"}]}\n\n'
      ));
      c.close();
    } }),
  });
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", fetchImpl, schedule: () => {}, log: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seenCtx.channelDelivery.ackEventId, "ok-1");
  listener.stop();
  stopAllListeners();
});

test("attach dedupes replayed eventIds: no second turn, but ACK still sent", async () => {
  stopAllListeners();
  let turns = 0;
  const posts = [];
  const core = { agent: { chat: async () => { turns++; return { role: "assistant", content: "ok" }; } } };
  const frame = (id) => 'data: {"type":"message","eventId":"' + id + '","instanceId":"bot","conversationKey":"G1","messages":[{"role":"user","content":"x"}]}\n\n';
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/proactive") && init && init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    // One stream, two frames with the same eventId (simulates replay).
    return {
      ok: true, status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(frame("same-id") + frame("same-id")));
          c.close();
        },
      }),
    };
  };
  let first = true;
  const dedupe = { claim: () => { const ok = first; first = false; return ok; } };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", fetchImpl, schedule: () => {},
    dedupe, emit: () => {}, log: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(turns, 1, "only one turn for a duplicated eventId");
  const ackPosts = posts.filter((p) => p.status === "ack");
  assert.equal(ackPosts.length, 2, "success consumption + duplicate event both ACKed");
  assert.equal(ackPosts[0].ackEventId, "same-id");
  listener.stop();
  stopAllListeners();
});

test("a thrown turn releases the claim without ACKing, so the event can retry", async () => {
  stopAllListeners();
  const posts = [];
  let released = null;
  const core = { agent: { chat: async () => { throw new Error("model crashed"); } } };
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/proactive") && init && init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return {
      ok: true, status: 200,
      body: new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"type":"message","eventId":"throw-1","instanceId":"bot","conversationKey":"G1","messages":[{"role":"user","content":"x"}]}\n\n'
        ));
        c.close();
      } }),
    };
  };
  const dedupe = {
    claim: () => true,
    release: (id) => { released = id; },
    commit: () => {},
    isPending: () => false,
  };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", fetchImpl, schedule: () => {}, log: () => {}, dedupe,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(released, "throw-1");
  assert.equal(posts.filter((p) => p.ackEventId === "throw-1").length, 0, "failure must not ACK");
  listener.stop();
  stopAllListeners();
});

test("a delivery failure leaves the event pending instead of ACKing it", async () => {
  stopAllListeners();
  const posts = [];
  const events = [];
  const core = {
    agent: {
      chat: async (ctx) => {
        ctx.channelDelivery.deliveryError = "QQ send failed";
        return { role: "assistant", content: "unused" };
      },
    },
  };
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/proactive") && init && init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return {
      ok: true, status: 200,
      body: new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"type":"message","eventId":"send-fail","instanceId":"bot","conversationKey":"G1","messages":[{"role":"user","content":"x"}]}\n\n'
        ));
        c.close();
      } }),
    };
  };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", fetchImpl, schedule: () => {}, log: () => {},
    emit: (e) => events.push(e),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posts.filter((p) => p.ackEventId === "send-fail").length, 0, "send failure must not ACK");
  assert.equal(events.some((e) => e.phase === "retry"), true);
  listener.stop();
  stopAllListeners();
});

test("attach subscribes to interactions and applies a button callback", async () => {
  stopAllListeners();
  const calls = [];
  const core = {
    agent: { chat: async () => ({ role: "assistant", content: "ok" }) },
    interactions: {
      approve: (id, decision) => { calls.push({ id, decision }); return true; },
    },
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("/interactions/subscribe")) {
      return {
        ok: true, status: 200,
        body: new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode(
            'data: {"type":"interaction","kind":"approval","id":7,"decision":"approve","eventId":"i7"}\n\n'
          ));
          // Keep the stream open; the listener is stopped explicitly.
        } }),
      };
    }
    return {
      ok: true, status: 200,
      body: new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"snapshot","count":0}\n\n'));
      } }),
    };
  };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", canPromptUser: true,
    fetchImpl, schedule: () => {}, log: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, [{ id: 7, decision: "approve" }]);
  listener.stop();
  stopAllListeners();
});

test("enableInteractions upgrades a late service without restarting core", async () => {
  stopAllListeners();
  const calls = [];
  const core = {
    agent: { chat: async () => ({ role: "assistant", content: "ok" }) },
    interactions: { approve: (id, decision) => { calls.push({ id, decision }); return true; } },
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("/interactions/subscribe")) {
      return {
        ok: true, status: 200,
        body: new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode(
            'data: {"type":"interaction","kind":"approval","id":11,"decision":"approve","eventId":"i11"}\n\n'
          ));
        } }),
      };
    }
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"snapshot","count":0}\n\n')); } }) };
  };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", canPromptUser: false, interactions: false,
    fetchImpl, schedule: () => {}, log: () => {},
  });
  assert.equal(listener.interactionListener, null);
  listener.enableInteractions();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, [{ id: 11, decision: "approve" }]);
  assert.equal(listener.interactionListener.state, "open");
  listener.stop();
  stopAllListeners();
});

test("attach projects approval cards before the suspended turn finishes", async () => {
  stopAllListeners();
  const posts = [];
  const core = {
    agent: {
      chat: async (ctx) => {
        ctx.onEvent({ type: "approval-request", id: 5, name: "Bash", arguments: { cmd: "ls" }, permission: "ask" });
        ctx.onEvent({ type: "final", content: "not a card" });
        return { role: "assistant", content: "done" };
      },
    },
  };
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/proactive") && init && init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return {
      ok: true, status: 200,
      body: new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"type":"message","eventId":"card-1","instanceId":"bot","conversationKey":"G1","senderId":"U1","recvType":"group","replyTo":"m1","messages":[{"role":"user","content":"x"}]}\n\n'
        ));
        c.close();
      } }),
    };
  };
  const listener = attach(core, {
    endpoint: "http://svc", instanceId: "bot", canPromptUser: true,
    fetchImpl, schedule: () => {}, log: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const cards = posts.filter((p) => p.event);
  assert.equal(cards.length, 1, "one approval card, final text is left to channel-send");
  assert.equal(cards[0].event.type, "approval-request");
  assert.equal(cards[0].replyTo, "m1");
  listener.stop();
  stopAllListeners();
});
