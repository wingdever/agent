"use strict";

// 云湖 outbound API: the bot token travels in the query string, not a header.
//
// Verified against the live gateway (bot "ami", id 83683850):
//   POST /bot/send?token=<bad>  -> HTTP 200 {"code":1003,"msg":"非法token"}
//   POST /bot/send?token=<good> -> HTTP 200 {"code":1,"data":{"messageInfo":{"msgId":...
//   POST /bot/edit (no recvId)  -> HTTP 200 {"code":1002,"msg":"recvId值错误，值不能为空"}
// Success is `code === 1`, not 0, and every failure is also HTTP 200. Reading
// `response.ok` here would turn "invalid token" into success.
//
// The token is also not a bearer-style credential the accounts layer can hold in
// headers, so the queue keeps only the retry/rate-limit role and the token is
// appended by this module.

import { createOutboundQueue } from "./../../accounts/outbound/queue.js";
import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";

export const DEFAULT_API_BASE = "https://chat-go.jwzhd.com/open-apis/v1";

// Only 1003 has been observed. Kept as a list so the driver never guesses another
// platform's auth code into meaning "retry".
const AUTH_CODES = [1003];

// Documented error table (doc 1-5) lists `1 = success`. The first version of
// this driver assumed 0, which would have failed every call against the live
// gateway while passing against its own fake.
const SUCCESS_CODE = 1;

/**
 * @param {{baseUrl?: string, token: string, fetchImpl?: Function, qps?: number, auth: Object}} options
 */
export function createYunhuApi({ baseUrl = DEFAULT_API_BASE, token, fetchImpl = globalThis.fetch, qps = 5, auth } = {}) {
  if (!token) throw new TypeError("yunhu api needs a bot token");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  const base = String(baseUrl).replace(/\/+$/, "");
  const queue = createOutboundQueue({ qps, maxAttempts: 2, auth });

  async function post(pathname, body) {
    return queue.push(async () => {
      // auth.headers() is empty for a bot token; the queue still wants it so
      // invalidate() can be a no-op without special casing in the queue.
      await auth.headers();
      const url = `${base}${pathname}?token=${encodeURIComponent(token)}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });

      if (response.status === 429 || response.status >= 500) {
        throw new ChannelError(ERROR_KINDS.RETRYABLE, `yunhu http ${response.status}`, { status: response.status });
      }
      const payload = await response.json().catch(() => ({}));
      const code = Number(payload.code);
      if (code === SUCCESS_CODE) return payload.data || {};
      const message = String(payload.msg || payload.message || `code ${payload.code}`);
      if (AUTH_CODES.includes(code)) {
        throw new ChannelError(ERROR_KINDS.AUTH, `yunhu auth rejected: ${message}`, { code });
      }
      throw new ChannelError(ERROR_KINDS.PLATFORM, `yunhu api error: ${message}`, { code });
    });
  }

  return {
    /** @param {{recvId: string, recvType: "user"|"group", contentType: string, content: Object, parentId?: string}} payload */
    send({ recvId, recvType, contentType = "text", content, parentId }) {
      const body = { recvId, recvType, contentType, content };
      if (parentId) body.parentId = parentId;
      return post("/bot/send", body);
    },

    /**
     * Update a message already sent: this is what makes throttled streaming possible.
     * `recvId`/`recvType` are mandatory and must match the original message (doc 437);
     * omitting them returns 1002 "recvId值错误，值不能为空".
     */
    edit({ msgId, recvId, recvType, content, contentType = "text" }) {
      if (!recvId || !recvType) throw new TypeError("yunhu edit needs recvId and recvType");
      return post("/bot/edit", { msgId, recvId, recvType, contentType, content });
    },

    recall({ msgId, chatId, chatType }) {
      if (!chatId || !chatType) throw new TypeError("yunhu recall needs chatId and chatType");
      return post("/bot/recall", { msgId, chatId, chatType });
    },
  };
}

/** Shape of a text content body, kept in one place so projector and api agree. */
export function textContent(text) {
  return { text: String(text) };
}

/** `/bot/send` answers `{messageInfo:{msgId,recvId,recvType}}`; this is the only readable id. */
export function sentMsgId(result) {
  return (result && result.messageInfo && result.messageInfo.msgId) || "";
}

export { AUTH_CODES, SUCCESS_CODE };
