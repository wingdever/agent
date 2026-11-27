"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannel } from "../../../channels/qq/index.js";
import { assertChannel } from "../../../channels/contract.js";
import { createQqApi, createQqAuth } from "../../../channels/qq/api.js";
import { parseDispatch } from "../../../channels/qq/events.js";
import { parseInteraction } from "../../../channels/qq/events.js";
import { buildApprovalCard, parseButtonData } from "../../../channels/qq/cards.js";
import { ERROR_KINDS } from "../../../accounts/errors.js";

/** A WebSocket stand-in the test drives by hand. */
function fakeSocket() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    closed: false,
    addEventListener(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    send(data) {
      sent.push(JSON.parse(String(data)));
    },
    close() {
      this.closed = true;
      this.emit("close", { code: 1000 });
    },
    emit(name, arg) {
      for (const fn of handlers.get(name) || []) fn(arg);
    },
  };
}

/** A fetch stand-in for token exchange, gateway lookup and message send. */
function fakeFetch({ failSend } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body });
    if (url.includes("bots.qq.com/app/getAppAccessToken")) {
      return json({ access_token: "tok_1", expires_in: "7200" });
    }
    if (url.endsWith("/gateway/bot")) {
      return json({ url: "wss://api.sgroup.qq.com/websocket", shards: 1 });
    }
    if (url.includes("/interactions/")) {
      return json({ code: 0 });
    }
    if (url.includes("/v2/")) {
      if (failSend) return json({ code: 401, message: "token invalid" }, 401);
      return json({ id: "qq_msg_1", timestamp: "2026-11-23T00:00:00+08:00" });
    }
    return json({}, 404);
  };
  impl.calls = calls;
  return impl;
}

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function waitForSocket(sockets) {
  for (let i = 0; i < 100; i++) {
    if (sockets.length) return sockets[0];
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("the driver never dialed a socket");
}

function build({ fetchImpl = fakeFetch(), sockets, deps = {}, credentials } = {}) {
  return createChannel({
    instance: {
      id: "qq-test",
      credentials: credentials || { appId: "1906507317", appSecret: "s3cret", botId: "10880449181683288941" },
      options: { qps: 0 },
    },
    deps: {
      fetch: fetchImpl,
      dial: () => {
        const s = fakeSocket();
        sockets.push(s);
        return s;
      },
      schedule: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      ...deps,
    },
  });
}

test("the driver is a socket channel that cannot stream", () => {
  const channel = createChannel({ instance: { id: "qq-contract", credentials: {} } });
  assertChannel(channel);
  assert.equal(channel.capabilities.eventMode, "ws");
  // QQ has no edit endpoint, so partial text would become extra messages.
  assert.equal(channel.capabilities.streaming, false);
  assert.equal(channel.capabilities.canAttachFiles, true);
});

test("credentials are checked at start and the message names the env variable", async () => {
  const bare = createChannel({ instance: { id: "qq-bare", credentials: {} }, deps: { fetch: fakeFetch(), dial: () => { throw new Error("must not dial"); } } });
  assert.deepEqual(bare.check(), [
    "credentials.appId is missing (or CHANNEL_QQ_BARE_APPID)",
    "credentials.appSecret is missing (or CHANNEL_QQ_BARE_APPSECRET)",
  ]);
  await assert.rejects(bare.start(async () => {}), /channel "qq-bare" cannot start: credentials\.appId is missing/);
});

test("identify uses the QQBot scheme and READY resolves start", async () => {
  const sockets = [];
  const fetchImpl = fakeFetch();
  const channel = build({ fetchImpl, sockets });
  try {
    const started = channel.start(async () => {});
    const socket = await waitForSocket(sockets);
    socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
    await new Promise((r) => setTimeout(r, 10)); // identify awaits the token exchange
    assert.deepEqual(socket.sent[0], {
      op: 2,
      d: { token: "QQBot tok_1", intents: (1 << 25) | (1 << 26), shard: [0, 1] },
    });
    socket.emit("message", { data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess_1", user: { id: "10880449181683288941", bot: true } } }) });
    await started;
    assert.equal(channel.gateway.sessionId, "sess_1");
    assert.equal(channel.gateway.seq, 1);
    // Token came from the exchange, and the gateway URL from /gateway/bot.
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("getAppAccessToken")).length, 1);
    assert.equal(fetchImpl.calls.some((c) => c.url.endsWith("/gateway/bot")), true);
  } finally {
    await channel.stop();
  }
});

test("the real turn's done event is sent as a passive reply", async () => {
  const fetchImpl = fakeFetch();
  const channel = build({ fetchImpl, sockets: [] });
  await channel.project(
    { recvType: "group", conversationKey: "G_DONE", replyTo: "m_done", messages: [] },
    { type: "done", message: { content: "真实轮次回包" } }
  );
  const sent = fetchImpl.calls.find((c) => c.url.includes("/v2/groups/G_DONE/messages"));
  assert.ok(sent, "done must produce a send, not be silently ignored");
  assert.equal(JSON.parse(sent.body).content, "真实轮次回包");
});

test("a group @ message runs one turn and answers passively with its id", async () => {
  const sockets = [];
  const fetchImpl = fakeFetch();
  const channel = build({ fetchImpl, sockets });
  const runs = [];
  try {
    const started = channel.start(async (message) => {
      runs.push(message);
      await channel.project(message, { type: "final", content: "收到" });
    });
    const socket = await waitForSocket(sockets);
    socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
    socket.emit("message", { data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s" } }) });
    await started;

    const dispatch = {
      op: 0,
      s: 2,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "qq_mid_1",
        content: "查一下天气",
        group_openid: "G_OPENID",
        author: { id: "u1", member_openid: "M_OPENID", bot: false },
      },
    };
    socket.emit("message", { data: JSON.stringify(dispatch) });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(runs.length, 1);
    assert.equal(runs[0].recvType, "group");
    assert.equal(runs[0].conversationKey, "G_OPENID");
    assert.equal(runs[0].replyTo, "qq_mid_1");

    const sentCall = fetchImpl.calls.find((c) => c.url.includes("/v2/groups/G_OPENID/messages"));
    assert.ok(sentCall, "answer must go to the group, not to the member openid");
    const body = JSON.parse(sentCall.body);
    assert.equal(body.content, "收到");
    assert.equal(body.msg_id, "qq_mid_1", "passive reply quotes the inbound id");
  } finally {
    await channel.stop();
  }
});

test("the bot's own messages and bot authors are ignored", () => {
  const own = {
    t: "GROUP_MESSAGE_CREATE",
    d: { id: "m1", content: "hi", group_openid: "g", author: { id: "10880449181683288941" } },
  };
  assert.equal(parseDispatch(own, { botId: "10880449181683288941" }), null);
  assert.equal(parseDispatch({ t: "GROUP_MESSAGE_CREATE", d: { id: "m2", content: "hi", author: { id: "x", bot: true } } }), null);
  // Message ids without text (image/file only) are not a prompt.
  assert.equal(parseDispatch({ t: "GROUP_MESSAGE_CREATE", d: { id: "m3", content: "", author: { id: "x" } } }), null);
});

test("a reconnect resumes with the stored session and sequence", async () => {
  const sockets = [];
  const scheduled = [];
  const channel = build({ sockets, deps: { schedule: (fn) => scheduled.push(fn) } });
  try {
    const started = channel.start(async () => {});
    const socket = await waitForSocket(sockets);
    socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
    socket.emit("message", { data: JSON.stringify({ op: 0, s: 3, t: "READY", d: { session_id: "sess_keep" } }) });
    await started;

    socket.emit("close", { code: 1006 });
    // A drop schedules a redial (the open-timeout timer is on the same scheduler,
    // so take the latest entry); nothing dials until that timer fires.
    assert.equal(sockets.length, 1);
    scheduled[scheduled.length - 1]();
    await new Promise((r) => setTimeout(r, 2));
    sockets[1].emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sockets[1].sent[0].op, 6, "op 6 resume, not op 2 identify");
    assert.equal(sockets[1].sent[0].d.session_id, "sess_keep");
    assert.equal(sockets[1].sent[0].d.seq, 3);
  } finally {
    await channel.stop();
  }
});

test("an expired token is re-acquired instead of reused", async () => {
  let t = 0;
  let exchanges = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes("getAppAccessToken")) {
      exchanges++;
      return json({ access_token: `tok_${exchanges}`, expires_in: "120" });
    }
    return json({});
  };
  const auth = createQqAuth({ appId: "a", appSecret: "s", fetchImpl, now: () => t });
  assert.deepEqual(await auth.headers(), { Authorization: "QQBot tok_1" });
  t = 70000; // past the 120s lifetime minus the 60s margin
  assert.deepEqual(await auth.headers(), { Authorization: "QQBot tok_2" });
  assert.equal(exchanges, 2);
  // QQ reports its own lifetime, so a 401 must also drop the cached token.
  await auth.invalidate();
  assert.deepEqual(await auth.headers(), { Authorization: "QQBot tok_3" });
});

test("a 401 on send becomes an auth error, not a platform error", async () => {
  const fetchImpl = fakeFetch({ failSend: true });
  const auth = createQqAuth({ appId: "a", appSecret: "s", fetchImpl });
  const api = createQqApi({ auth, fetchImpl, qps: 0 });
  await assert.rejects(
    api.sendMessage({ groupOpenId: "g", content: "x", msgId: "m" }),
    (err) => err.kind === ERROR_KINDS.AUTH
  );
});

test("attachments survive parsing, including a file with no caption", () => {
  const frame = {
    t: "GROUP_MESSAGE_CREATE",
    d: {
      id: "m_file",
      content: "",
      group_openid: "G_OPENID",
      author: { id: "u1" },
      attachments: [{ url: "https://multimedia.nt.qq.com.cn/download?fileid=x", filename: "report.pdf", size: 1048576, content_type: "file" }],
    },
  };
  const parsed = parseDispatch(frame);
  assert.ok(parsed, "an attachment-only message is still a message");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].kind, "file");
  assert.equal(parsed.attachments[0].name, "report.pdf");
  assert.equal(parsed.attachments[0].size, 1048576);
  // The prompt text must say something -- the model never sees the array.
  assert.equal(parsed.messages[0].content, "[attachment] report.pdf (file, 1.0MB)");
  assert.ok(!parsed.messages[0].content.includes("https://"), "signed url stays out of the prompt");
});

test("images keep their dimensions and voice keeps the wav url", () => {
  const img = parseDispatch({
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "m_img", content: "看图", group_openid: "g", author: { id: "u" },
      attachments: [{ url: "https://x/i", filename: "p.jpg", size: 256000, content_type: "image/jpeg", width: 1920, height: 1080 }],
    },
  });
  assert.equal(img.attachments[0].kind, "image");
  assert.equal(img.attachments[0].width, 1920);
  assert.equal(img.messages[0].content, "看图\n[attachment] p.jpg (image/jpeg 1920x1080, 250.0KB)");
  assert.equal(img.mentioned, true, "the mention flag still comes from the event type");

  const voice = parseDispatch({
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "m_v", content: "", author: { user_openid: "U1" },
      attachments: [{ url: "https://x/v", content_type: "voice", size: 12000, voice_wav_url: "https://x/v.wav" }],
    },
  });
  assert.equal(voice.attachments[0].kind, "voice");
  assert.equal(voice.attachments[0].voiceUrl, "https://x/v.wav");
  assert.equal(voice.attachments[0].name, "voice", "no filename means a kind-based placeholder");
});

test("attachments with no url, or from a bot, are dropped", () => {
  const urlless = { id: "m_bad", content: "", group_openid: "g", author: { id: "u" }, attachments: [{ filename: "x.pdf", content_type: "file" }] };
  assert.equal(parseDispatch({ t: "GROUP_MESSAGE_CREATE", d: urlless }), null);
  const selfAttach = { id: "m_self", content: "", group_openid: "g", author: { id: "bot1" }, attachments: [{ url: "https://x", content_type: "file" }] };
  assert.equal(parseDispatch({ t: "GROUP_MESSAGE_CREATE", d: selfAttach }, { botId: "bot1" }), null);
});

test("a 200 response with err_code is a failure, not a sent message", async () => {
  const cases = [
    [{ err_code: 40034005, message: "回复消息msg_id已过期" }, ERROR_KINDS.PLATFORM, "40034005"],
    [{ err_code: 1100100, message: "rate limited" }, ERROR_KINDS.RETRYABLE, "1100100"],
    [{ err_code: 11243, message: "invalid token" }, ERROR_KINDS.AUTH, "11243"],
  ];
  for (const [body, kind, codeText] of cases) {
    const fetchImpl = async (url) => {
      if (url.includes("getAppAccessToken")) return json({ access_token: "tok_1", expires_in: "7200" });
      return json(body, 200);
    };
    const auth = createQqAuth({ appId: "a", appSecret: "s", fetchImpl });
    const api = createQqApi({ auth, fetchImpl, qps: 0 });
    await assert.rejects(
      api.sendMessage({ groupOpenId: "g", content: "x", msgId: "m" }),
      (err) => err.kind === kind && err.code === Number(codeText) && err.message.includes(codeText)
    );
  }
});

test("a button's data survives the round trip and an approval card carries a keyboard", () => {
  const card = buildApprovalCard({ id: 7, name: "Bash", args: { command: "ls" }, permission: "ask" });
  assert.match(card.text, /Bash/);
  const row = card.keyboard.content.rows[0].buttons;
  assert.equal(row.length, 2);
  assert.deepEqual(parseButtonData(row[0].action.data), { kind: "approval", id: 7, decision: "approve" });
  assert.deepEqual(parseButtonData("qq:a:7:deny"), { kind: "approval", id: 7, decision: "deny" });
  assert.equal(parseButtonData("qq:a:7:other"), null);
  assert.equal(parseButtonData("not-ours"), null);
});

test("INTERACTION_CREATE is only parsed when it is a keyboard callback", () => {
  const frame = {
    t: "INTERACTION_CREATE",
    d: {
      id: "int_1",
      type: 11,
      group_openid: "G1",
      group_member_openid: "U1",
      data: { resolved: { button_id: "allow", button_data: "qq:a:1:approve" } },
    },
  };
  assert.deepEqual(parseInteraction(frame), {
    type: "qq",
    instanceId: "",
    conversationKey: "G1",
    eventId: "int_1",
    interactionId: "int_1",
    buttonId: "allow",
    buttonData: "qq:a:1:approve",
    senderId: "U1",
    recvType: "group",
    scene: "",
    raw: { event: "INTERACTION_CREATE", id: "int_1", groupOpenId: "G1", senderId: "U1" },
  });
  assert.equal(parseInteraction({ ...frame, d: { ...frame.d, type: 2 } }), null);
  assert.equal(parseInteraction({ t: "GROUP_AT_MESSAGE_CREATE", d: {} }), null);
});

test("a click is acknowledged before it is routed into the pending interaction", async () => {
  const fetchImpl = fakeFetch();
  const sockets = [];
  const channel = build({ fetchImpl, sockets });
  const received = [];
  const started = channel.start(async () => {}, async (interaction) => received.push(interaction));
  const socket = await waitForSocket(sockets);
  socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
  await new Promise((r) => setTimeout(r, 10));
  socket.emit("message", { data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess_1", user: { id: "bot" } } }) });
  await new Promise((r) => setTimeout(r, 10));

  try {
    await channel.project(
      { recvType: "group", conversationKey: "G1", replyTo: "m_in", senderId: "U1", messages: [] },
      { type: "approval-request", id: 1, name: "Bash", arguments: { command: "rm -rf /tmp/x" }, permission: "ask" },
    );

    const send = fetchImpl.calls.find((c) => c.url.includes("/v2/groups/G1/messages"));
    assert.ok(send);
    const body = JSON.parse(send.body);
    assert.equal(body.msg_type, 2);
    assert.equal(body.msg_id, "m_in");
    assert.equal(body.msg_seq, 1);
    assert.ok(body.keyboard.content.rows[0].buttons.length === 2);

    socket.emit("message", {
      data: JSON.stringify({
        op: 0,
        s: 2,
        t: "INTERACTION_CREATE",
        d: {
          id: "int_1",
          type: 11,
          group_openid: "G1",
          group_member_openid: "U1",
          data: { resolved: { button_id: "allow", button_data: "qq:a:1:approve" } },
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(received.map((i) => [i.kind, i.id, i.decision]), [["approval", 1, "approve"]]);
    const ack = fetchImpl.calls.find((c) => c.url.includes("/interactions/int_1"));
    assert.equal(ack.method, "PUT");
    assert.deepEqual(JSON.parse(ack.body), { code: 0 });
  } finally {
    await channel.stop();
  }
});

test("a group member cannot answer someone else's approval", async () => {
  const fetchImpl = fakeFetch();
  const sockets = [];
  const channel = build({ fetchImpl, sockets });
  const received = [];
  const started = channel.start(async () => {}, async (interaction) => received.push(interaction));
  const socket = await waitForSocket(sockets);
  socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
  await new Promise((r) => setTimeout(r, 10));
  socket.emit("message", { data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s", user: { id: "bot" } } }) });
  await new Promise((r) => setTimeout(r, 10));

  try {
    await channel.project(
      { recvType: "group", conversationKey: "G1", replyTo: "m_in", senderId: "U1", messages: [] },
      { type: "approval-request", id: 2, name: "Bash", permission: "ask" },
    );
    socket.emit("message", {
      data: JSON.stringify({
        op: 0, s: 2, t: "INTERACTION_CREATE",
        d: {
          id: "int_2", type: 11, group_openid: "G1", group_member_openid: "U2",
          data: { resolved: { button_data: "qq:a:2:approve" } },
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 0);
    const ack = fetchImpl.calls.find((c) => c.url.includes("/interactions/int_2"));
    assert.deepEqual(JSON.parse(ack.body), { code: 4 });
  } finally {
    await channel.stop();
  }
});

test("a single-select question is answered by one button and resolves the batch", async () => {
  const fetchImpl = fakeFetch();
  const sockets = [];
  const channel = build({ fetchImpl, sockets });
  const received = [];
  const started = channel.start(async () => {}, async (interaction) => received.push(interaction));
  const socket = await waitForSocket(sockets);
  socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }) });
  await new Promise((r) => setTimeout(r, 10));
  socket.emit("message", { data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s", user: { id: "bot" } } }) });
  await new Promise((r) => setTimeout(r, 10));

  try {
    await channel.project(
      { recvType: "group", conversationKey: "G1", replyTo: "m_in", senderId: "U1", messages: [] },
      {
        type: "ask-user-question",
        id: 3,
        questions: [{ id: "q1", header: "部署", question: "用哪个环境？", options: [{ label: "预发" }, { label: "生产" }] }],
      },
    );
    socket.emit("message", {
      data: JSON.stringify({
        op: 0, s: 2, t: "INTERACTION_CREATE",
        d: {
          id: "int_3", type: 11, group_openid: "G1", group_member_openid: "U1",
          data: { resolved: { button_data: "qq:q:3:q1:1" } },
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received.map((i) => [i.kind, i.id, i.answers]), [["question", 3, [{ id: "q1", selected: ["生产"] }]]]);
  } finally {
    await channel.stop();
  }
});
