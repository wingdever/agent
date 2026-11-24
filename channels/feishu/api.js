"use strict";

// Minimal feishu messaging client: two operations, both paced by the shared
// outbound queue. Auth headers come from accounts/auth, so a dead token is
// invalidated and re-acquired by the queue rather than handled here.

import { ChannelError, ERROR_KINDS, isAuthCode, isThrottleCode } from "./../../accounts/errors.js";
import { createOutboundQueue } from "./../../accounts/outbound/queue.js";

export const MESSAGE_PATH = "/open-apis/im/v1/messages";

/** Interactive card wrapping a markdown element: the shape feishu accepts for patches. */
export function cardBody(text) {
  return JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: text }] } });
}

/**
 * @param {{baseUrl: string, auth: Object, fetchImpl?: Function, qps?: number, queue?: Object}} options
 */
export function createFeishuApi({ baseUrl, auth, fetchImpl = globalThis.fetch, qps = 5, queue } = {}) {
  const outbound = queue || createOutboundQueue({ qps, auth });

  async function request(path, { method = "POST", body } = {}) {
    const headers = { "Content-Type": "application/json; charset=utf-8", ...(await auth.headers()) };
    const response = await fetchImpl(baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const kind = response.status === 401 || response.status === 403 ? ERROR_KINDS.AUTH : ERROR_KINDS.PLATFORM;
      throw new ChannelError(kind, `feishu http ${response.status}`, { status: response.status });
    }
    if (payload.code !== 0) {
      // 230429 arrives with HTTP 200, so the code is the only signal that this is
      // pacing pressure rather than a refusal; the outbound queue owns the retry.
      const kind = isAuthCode(payload.code)
        ? ERROR_KINDS.AUTH
        : isThrottleCode(payload.code)
          ? ERROR_KINDS.RETRYABLE
          : ERROR_KINDS.PLATFORM;
      throw new ChannelError(kind, `feishu api ${payload.code}: ${payload.msg || ""}`, { code: payload.code });
    }
    return payload.data || {};
  }

  /** Create the reply card; returns the message id used for later patches. */
  function sendCard({ receiveId, text }) {
    return outbound.push(async () => {
      const data = await request(`${MESSAGE_PATH}?receive_id_type=chat_id`, {
        body: { receive_id: receiveId, msg_type: "interactive", content: cardBody(text) },
      });
      if (!data.message_id) throw new ChannelError(ERROR_KINDS.PLATFORM, "feishu did not return a message_id");
      return data.message_id;
    });
  }

  /** Replace the card content (streaming update). */
  function patchCard(messageId, text) {
    return outbound.push(() =>
      request(`${MESSAGE_PATH}/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        body: { content: cardBody(text) },
      })
    );
  }

  return { sendCard, patchCard, stats: outbound.stats };
}
