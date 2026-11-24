"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { createChannel } from "../../../channels/qq/index.js";
import { assertChannel } from "../../../channels/contract.js";
import { createQqApi, createQqAuth } from "../../../channels/qq/api.js";
import { parseDispatch } from "../../../channels/qq/events.js";
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
      d: { token: "QQBot tok_1", intents: 1 << 25, shard: [0, 1] },
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
