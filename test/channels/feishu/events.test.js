"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvent, extractText, SUPPORTED_EVENT } from "../../../channels/feishu/events.js";

function envelope({ eventId = "evt-1", text = "在吗", chatId = "oc_1", senderType = "user", messageType = "text", content } = {}) {
  return {
    schema: "2.0",
    header: { event_id: eventId, event_type: SUPPORTED_EVENT, create_time: "1700000000000", app_id: "cli_test" },
    event: {
      sender: { sender_id: { open_id: "ou_1" }, sender_type: senderType, tenant_key: "tenant" },
      message: {
        message_id: `om_in_${eventId}`,
        chat_id: chatId,
        chat_type: "group",
        message_type: messageType,
        content: content === undefined ? JSON.stringify({ text }) : content,
      },
    },
  };
}

test("a user text message becomes a normalized inbound message", () => {
  const message = parseEvent(envelope(), { type: "feishu", instanceId: "fs-1" });
  assert.equal(message.type, "feishu");
  assert.equal(message.instanceId, "fs-1");
  assert.equal(message.conversationKey, "oc_1");
  assert.equal(message.eventId, "evt-1");
  assert.equal(message.senderId, "ou_1");
  assert.deepEqual(message.messages, [{ role: "user", content: "在吗" }]);
});

test("raw is trimmed to routing fields only, so group payloads are not stored", () => {
  const message = parseEvent(envelope());
  assert.deepEqual(Object.keys(message.raw).sort(), ["chat_id", "event_id", "event_type", "message_id"]);
});

test("messages the bot itself sent are ignored", () => {
  assert.equal(parseEvent(envelope({ senderType: "app" })), null);
});

test("events of another type are ignored", () => {
  const other = envelope();
  other.header.event_type = "im.chat.member.bot.added_v1";
  assert.equal(parseEvent(other), null);
});

test("non-text messages yield nothing rather than an empty turn", () => {
  assert.equal(parseEvent(envelope({ messageType: "image", content: "{}" })), null);
  assert.equal(parseEvent(envelope({ content: "not json" })), null);
});

test("mention placeholders are stripped from the text", () => {
  assert.equal(extractText({ message_type: "text", content: JSON.stringify({ text: "@_user_1 帮我看下" }) }), "帮我看下");
});
