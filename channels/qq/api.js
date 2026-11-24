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
        throw new ChannelError(ERROR_KINDS.AUTH, `qq token rejected: ${payload.message || payload.code || response.status}`, {
          status: response.status,
          code: payload.code,
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
    return payload;
  }

  return {
    /** The socket URL is per bot; shards tells us whether identify needs one shard. */
    gateway() {
      return call("GET", "/gateway/bot");
    },
    /**
     * Passive reply: QQ only allows a fresh message when it carries the id of the
     * one being answered (active pushes have a separate, ratelimited quota).
     * @param {{groupOpenId?: string, userOpenId?: string, content: string, msgId: string, msgType?: number}} input
     */
    sendMessage({ groupOpenId, userOpenId, content, msgId, msgType = 0 }) {
      const target = groupOpenId ? `/v2/groups/${groupOpenId}/messages` : `/v2/users/${userOpenId}/messages`;
      if (!groupOpenId && !userOpenId) throw new TypeError("qq send needs groupOpenId or userOpenId");
      const body = { content, msg_type: msgType };
      if (msgId) body.msg_id = msgId;
      return call("POST", target, body);
    },
  };
}
