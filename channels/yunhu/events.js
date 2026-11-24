"use strict";

// 云湖 (yunhu) webhook event intake.
//
// Field names were first reconstructed from a third-party adapter
// (ErisPulse-YunhuAdapter) and then confirmed against the live gateway on a
// real group message: header.eventType / header.eventId, event.message.{msgId,
// contentType,content}, event.sender.senderId, event.chat.{chatType,chatId}.
// `content.at` is absent when nobody is mentioned, so any mention gate has to
// treat a missing array as "not mentioned".
//
// Two platform quirks that shape this module:
//   - The event carries no bot id, so "did I send this myself?" cannot be answered
//     by the payload alone; the configured bot id is compared against senderId.
//   - chatType is "bot" for a direct chat with the bot (private) and anything else
//     (typically "group") for a group; that is what decides the outbound recvType.

export const MESSAGE_EVENTS = ["message.receive.normal", "message.receive.instruction"];

/**
 * @param {Object} envelope raw webhook body
 * @param {{type?: string, instanceId?: string, botId?: string, known?: Set<string>}} [context]
 * @returns {Object|null} null when the event is not one this channel should act on
 */
export function parseEvent(envelope, { type = "yunhu", instanceId = "", botId = "", known = null, requireMention = true } = {}) {
  if (!envelope || typeof envelope !== "object") return null;

  // The adapter reads data["event"] for the payload and data["header"] for routing
  // metadata; a v2-style flat body would silently produce an empty message.
  const header = envelope.header || {};
  const event = envelope.event || {};
  if (!MESSAGE_EVENTS.includes(header.eventType)) return null;

  const message = event.message || {};
  const sender = event.sender || {};
  const chat = event.chat || {};

  const senderId = String(sender.senderId || "");
  // A bot that answers its own echo is an infinite loop with real cost, so this
  // filter is a correctness requirement, not a nicety.
  if (botId && senderId === String(botId)) return null;
  if (known && senderId && known.has(senderId)) return null;

  const text = extractText(message);
  if (!text) return null;

  const chatType = String(chat.chatType || "");

  // `content.at` is an array of user ids and is simply absent when nobody is
  // mentioned (verified on the live gateway: "@ami 看看" arrives as
  // {"text":"@ami 看看","at":["83683850"]}, a plain message has no `at` key).
  // A group bot hears every message, so without this gate it answers the whole
  // room; an instruction event is by definition aimed at the bot and always passes.
  const content = message.content || {};
  const at = Array.isArray(content.at) ? content.at.map((id) => String(id)) : [];
  const mentioned = Boolean(botId) && at.includes(String(botId));
  const instruction = header.eventType === "message.receive.instruction";
  const direct = chatType === "bot";
  if (requireMention && !direct && !instruction && !mentioned) return null;
  const conversationKey = String(chat.chatId || senderId || "");
  if (!conversationKey) return null;

  return {
    type,
    instanceId,
    conversationKey,
    eventId: String(header.eventId || message.msgId || ""),
    senderId,
    // "bot" means the user is talking to the bot directly; everything else is a
    // group conversation. Outbound needs this to pick recvType.
    recvType: chatType === "bot" ? "user" : "group",
    replyTo: String(message.msgId || ""),
    mentioned,
    instruction,
    messages: [{ role: "user", content: text }],
    raw: {
      eventType: header.eventType,
      eventId: header.eventId,
      msgId: message.msgId,
      chatType,
      chatId: chat.chatId,
    },
  };
}

/** Plain text from a yunhu message body; non-text types return "". */
export function extractText(message = {}) {
  const contentType = message.contentType || "text";
  if (contentType !== "text") return "";
  const content = message.content || {};
  const raw = typeof content.text === "string" ? content.text : "";
  // "@bot 你好" is addressed to us but the mention itself is not part of the ask.
  // The live gateway separates the mention from the text with a zero-width space
  // (U+200B), so stripping "@name" alone would leave an invisible character glued
  // to the first real word -- hence the explicit zero-width trim.
  return raw
    .replace(/@[\S]+\s*/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}
