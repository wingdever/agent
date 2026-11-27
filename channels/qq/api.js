"use strict";

// QQ 官方机器人 outbound API.
//
// Two credentials, two hops: appid + appsecret are exchanged for a short lived
// `access_token` (the live gateway reports expires_in ≈ 7142s), and that token
// travels as `Authorization: QQBot <token>`. Unlike yunhu's static bot token this
// one actually rotates, so accounts/auth's refresh path is used for real here --
// this is the first channel where `rotates` is not a no-op.
//
// Verified live: token exchange 200, `GET /gateway` 200
// {"url":"wss://api.sgroup.qq.com/websocket","shards":1, ...}.

import { createAppSecretTokenAuth } from "./../../accounts/auth/index.js";
import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";

export const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
export const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// QQ reports business failures in a 200 response body: `err_code` is the
// authority, `message` is explanatory text that may change. Checking only
// response.ok silently swallows "msg_id expired", "private messages closed"
// and security rejections -- the send looks successful and nothing is sent.
const AUTH_ERR_CODES = new Set([
  11242, // check token failed
  11243, // token not valid
  11251, // wrong appid
  11252, // app privilege check failed
  11253, // app privilege not granted
  11254, // interface banned
  11261, // appid missing
  11275, // appid missing (variant)
]);
const RETRYABLE_ERR_CODES = new Set([
  1100100, // rate limited by the security layer
  1100300, // internal error
  304018,  // bot not connected to the gateway
]);

/** appid/appsecret -> rotating access token, cached until shortly before expiry. */
export function createQqAuth({ appId, appSecret, fetchImpl = globalThis.fetch, now } = {}) {
  if (!appId || !appSecret) throw new TypeError("qq auth needs appId and appSecret");
  return createAppSecretTokenAuth({
    headerName: "Authorization",
    // QQ's scheme name is part of the header value, not a header name.
    format: (token) => `QQBot ${token}`,
    now,
    fetchToken: async () => {
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!payload.access_token) {
        const code = payload.err_code || payload.code;
        throw new ChannelError(ERROR_KINDS.AUTH, `qq token rejected: ${payload.message || code || response.status}`, {
          status: response.status,
          code,
        });
      }
      return { token: payload.access_token, expiresInMs: Number(payload.expires_in) * 1000 };
    },
  });
}

export function createQqApi({ auth, baseUrl = DEFAULT_API_BASE, fetchImpl = globalThis.fetch, qps = 3 } = {}) {
  if (!auth) throw new TypeError("qq api needs auth");
  const base = String(baseUrl).replace(/\/+$/, "");
  let lastSentAt = 0;
  const minIntervalMs = qps > 0 ? 1000 / qps : 0;

  async function call(method, pathname, body) {
    const gap = Date.now() - lastSentAt;
    if (gap < minIntervalMs) await new Promise((r) => setTimeout(r, minIntervalMs - gap));
    lastSentAt = Date.now();

    const headers = { ...(await auth.headers()) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401) throw new ChannelError(ERROR_KINDS.AUTH, "qq token rejected", { status: 401 });
    if (response.status === 429 || response.status >= 500) {
      throw new ChannelError(ERROR_KINDS.RETRYABLE, `qq http ${response.status}`, { status: response.status });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ChannelError(ERROR_KINDS.PLATFORM, `qq api error: ${payload.message || payload.code || response.status}`, {
        status: response.status,
        code: payload.code,
      });
    }
    const errCode = Number(payload.err_code || 0);
    if (errCode !== 0) {
      const kind = AUTH_ERR_CODES.has(errCode)
        ? ERROR_KINDS.AUTH
        : RETRYABLE_ERR_CODES.has(errCode)
          ? ERROR_KINDS.RETRYABLE
          : ERROR_KINDS.PLATFORM;
      const message = String(payload.message || "business error");
      throw new ChannelError(kind, `qq api error ${errCode}: ${message}`, {
        status: response.status,
        code: errCode,
      });
    }
    return payload;
  }

  return {
    /** Shared HTTP caller: throttled, authenticated, classified. */
    call,

    /**
     * Passive reply: QQ only allows a fresh message when it carries the id of the
     * one being answered (active pushes have a separate, ratelimited quota).
     *
     * A card is still a message: `msg_type=2` + `markdown` + `keyboard`. `content`
     * is kept as the plain fallback because group sends require it.
     *
     * @param {{
     *   groupOpenId?: string, userOpenId?: string,
     *   content?: string, msgId?: string, eventId?: string,
     *   msgType?: number, msgSeq?: number,
     *   markdown?: Object, keyboard?: Object
     * }} input
     */
    sendMessage({
      groupOpenId,
      userOpenId,
      content,
      msgId,
      eventId,
      msgType = 0,
      msgSeq,
      markdown,
      keyboard,
    }) {
      const target = groupOpenId ? `/v2/groups/${groupOpenId}/messages` : `/v2/users/${userOpenId}/messages`;
      if (!groupOpenId && !userOpenId) throw new TypeError("qq send needs groupOpenId or userOpenId");
      const body = { msg_type: msgType };
      if (content !== undefined) body.content = content;
      if (markdown !== undefined) body.markdown = markdown;
      if (keyboard !== undefined) body.keyboard = keyboard;
      if (msgId) body.msg_id = msgId;
      if (eventId) body.event_id = eventId;
      // Two replies to the same inbound message need distinct msg_seq; QQ rejects
      // a repeated msg_id + msg_seq pair even when the body differs.
      if (Number.isInteger(msgSeq)) body.msg_seq = msgSeq;
      return call("POST", target, body);
    },

    /**
     * Acknowledge a button callback. This is not a message send: the client
     * keeps a loading spinner until this PUT arrives, and the same interaction
     * id can only be acknowledged once.
     *
     * @param {string} interactionId
     * @param {number} [code] 0=success, 1=failed, 2=too frequent, 3=duplicate, 4=no permission
     */
    ackInteraction(interactionId, code = 0) {
      if (!interactionId) throw new TypeError("qq ackInteraction needs an interaction id");
      return call("PUT", `/interactions/${encodeURIComponent(interactionId)}`, { code: Number(code) || 0 });
    },
  };
}
