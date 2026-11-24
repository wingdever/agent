"use strict";

// Parse a feishu event envelope into the channel-neutral InboundMessage.
//
// This is the only place that knows the feishu wire format. Everything above it
// (dedupe, serial queue, projection) sees conversationKey / eventId / senderId /
// messages and nothing else.
//
// `raw` is trimmed on purpose: group payloads can carry other people's data, and
// the doc's credential/privacy boundary says only routing fields may be stored.

export const SUPPORTED_EVENT = "im.message.receive_v1";

/**
 * @param {Object} envelope feishu event v2 payload
 * @param {{type?: string, instanceId?: string}} [context]
 * @returns {Object|null} null when the event is not something a channel should act on
 */
export function parseEvent(envelope, { type = "feishu", instanceId = "" } = {}) {
  if (!envelope || typeof envelope !== "object") return null;

  const header = envelope.header || {};
  if (header.event_type !== SUPPORTED_EVENT) return null;

  const event = envelope.event || {};
  const message = event.message || {};
  const sender = event.sender || {};

  // Ignore anything the bot itself (or another app) said; replying to your own
  // messages is the shortest path to an infinite loop.
  if (sender.sender_type && sender.sender_type !== "user") return null;

  const text = extractText(message);
  if (!text) return null;

  const senderId = (sender.sender_id && (sender.sender_id.open_id || sender.sender_id.user_id)) || "";

  return {
    type,
    instanceId,
    conversationKey: message.chat_id || "",
    eventId: header.event_id || message.message_id || "",
    senderId,
    messages: [{ role: "user", content: text }],
    raw: {
      event_id: header.event_id,
      event_type: header.event_type,
      chat_id: message.chat_id,
      message_id: message.message_id,
    },
  };
}

/** Extract plain text from a feishu message body; unsupported types return "". */
export function extractText(message) {
  if (!message || message.message_type !== "text") return "";
  let parsed = null;
  try {
    parsed = JSON.parse(message.content || "{}");
  } catch (_) {
    return "";
  }
  const raw = typeof parsed.text === "string" ? parsed.text : "";
  // Mentions arrive as "@_user_1" placeholders; they carry no meaning for the model.
  return raw.replace(/@_user_\d+/g, "").trim();
}
