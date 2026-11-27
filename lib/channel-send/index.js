"use strict";

// Send a message to a channel service through its callback endpoint.
//
// This is the single transport primitive used by both the node-graph channel
// node (编排的节点) and, later, the model-invocable tool (显式传参的工具).
// It knows nothing about agent turns — it only POSTs a validated payload to a
// channel service's /proactive endpoint and reports the result.

const DEFAULT_PATH = "/proactive";

function endpointFor(base, path = DEFAULT_PATH) {
  return String(base || "").replace(/\/+$/, "") + path;
}

/**
 * @param {Object} options
 * @param {string} options.endpoint channel service base URL (http://host:port)
 * @param {string} options.instanceId channel instance id
 * @param {string} options.conversationKey platform conversation key
 * @param {string} options.text message text
 * @param {string} [options.senderId]
 * @param {string} [options.recvType] "group" | "user"
 * @param {Function} [options.fetchImpl]
 */
export async function sendToChannel({
  endpoint,
  instanceId,
  conversationKey,
  text,
  senderId = "",
  recvType = "group",
  ackEventId = null,
  status = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!endpoint) throw new TypeError("sendToChannel needs an endpoint");
  if (!instanceId) throw new TypeError("sendToChannel needs an instanceId");
  if (!conversationKey) throw new TypeError("sendToChannel needs a conversationKey");
  if (!text && status !== "failed") throw new TypeError("sendToChannel needs text");

  const body = {
    instanceId: String(instanceId),
    conversationKey: String(conversationKey),
    text: String(text || ""),
    senderId: String(senderId || ""),
    recvType: recvType === "user" ? "user" : "group",
  };
  if (ackEventId) body.ackEventId = String(ackEventId);
  if (status) body.status = status;

  const response = await fetchImpl(endpointFor(endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let payload = null;
  try { payload = await response.json(); } catch (_) { /* non-json response */ }
  if (!response.ok || (payload && payload.ok === false)) {
    const message = (payload && payload.error) || `http ${response.status}`;
    throw new Error(`sendToChannel failed: ${message}`);
  }
  return payload;
}

export default { sendToChannel, endpointFor, DEFAULT_PATH };
