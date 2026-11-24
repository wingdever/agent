"use strict";

// Fake yunhu gateway: the bot API plus a webhook injector.
//
// It copies the shape verified against the live gateway (HTTP 200 + {code,msg},
// token in the query) so the driver can be exercised without a real bot. What it
// cannot prove: the real edit rate limit, socket framing/reconnect behaviour of the
// long connection, and the platform's own mention rules. The event field names and
// the {code,msg} envelope are copied from frames captured on the live gateway.

import http from "http";

/** One inbound message event, shaped like the platform's webhook body. */
export function fakeEnvelope({ eventId = "evt_1", msgId = "msg_1", recvId = "u_1", recvType = "user", text = "在吗", eventType = "message.receive.normal", at = null } = {}) {
  const isGroup = recvType === "group";
  return {
    header: { eventType, eventId, eventTime: 1_700_000_000_000 },
    event: {
      // `at` is absent on a plain message and a list of user ids when someone is
      // mentioned, which is exactly what the live gateway does.
      message: { msgId, contentType: "text", content: at ? { text, at } : { text } },
      sender: { senderId: recvId, senderNickname: "tester" },
      chat: { chatId: isGroup ? recvId : "", chatType: isGroup ? "group" : "bot" },
    },
  };
}

export function createFakeYunhuPlatform({ token = "tok_test", botId = "30535459" } = {}) {
  const state = {
    sends: [],
    edits: [],
    recalls: [],
    rejected: 0,
    failNextAuth: false,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const respond = (payload, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
      res.end(JSON.stringify(payload));
    };

    if (url.searchParams.get("token") !== token || state.failNextAuth) {
      state.failNextAuth = false;
      state.rejected++;
      respond({ code: 1003, msg: "非法token" });
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch (_) {
        respond({ code: 1001, msg: "bad json" });
        return;
      }
      if (url.pathname === "/open-apis/v1/bot/send") {
        const msgId = `msg_${state.sends.length + 1}`;
        state.sends.push({ ...payload, msgId, at: Date.now() });
        // Mirrors the live gateway: success is code 1 and the id lives under
        // `data.messageInfo.msgId`, not at the top of `data`.
        respond({ code: 1, msg: "success", data: { messageInfo: { msgId, recvId: payload.recvId, recvType: payload.recvType } } });
        return;
      }
      if (url.pathname === "/open-apis/v1/bot/edit") {
        // The live gateway refuses an edit without recvId/recvType, so the fake
        // must too: a fake that accepts less than the real thing hides bugs.
        if (!payload.recvId || !payload.recvType) {
          respond({ code: 1002, msg: "recvId值错误，值不能为空" });
          return;
        }
        state.edits.push({ ...payload, at: Date.now() });
        respond({ code: 1, msg: "success", data: { successCount: 1 } });
        return;
      }
      if (url.pathname === "/open-apis/v1/bot/recall") {
        state.recalls.push(payload);
        respond({ code: 1, msg: "success", data: { successCount: 1 } });
        return;
      }
      respond({ code: 404, msg: "unknown endpoint" }, 404);
    });
  });

  return {
    token,
    botId,
    get url() {
      return `http://127.0.0.1:${server.address().port}/open-apis/v1`;
    },
    get state() {
      return state;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return this;
    },
    async stop() {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
    /** Post one event to a webhook URL, the way the platform would. */
    async deliver(webhookUrl, envelope = fakeEnvelope()) {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    },
    failNextAuth() {
      state.failNextAuth = true;
    },
  };
}
