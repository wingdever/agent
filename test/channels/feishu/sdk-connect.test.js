"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { toEnvelope, createSdkConnect } from "../../../channels/feishu/sdk-connect.js";
import { parseEvent } from "../../../channels/feishu/events.js";

// Exactly what the SDK's RequestHandle.parse produces for a v2 message event:
// header fields flattened onto the top level, sender/message still nested.
const sdkPayload = {
  event_type: "im.message.receive_v1",
  event_id: "evt-sdk-1",
  create_time: "1700000000000",
  app_id: "cli_x",
  tenant_key: "tenant",
  sender: { sender_id: { open_id: "ou_9" }, sender_type: "user" },
  message: {
    message_id: "om_9",
    chat_id: "oc_9",
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text: "来自 SDK" }),
  },
};

test("the SDK's flattened payload maps back to an inbound message", () => {
  const envelope = toEnvelope(sdkPayload);
  const message = parseEvent(envelope, { instanceId: "fs-sdk" });
  assert.equal(message.instanceId, "fs-sdk");
  assert.equal(message.conversationKey, "oc_9");
  assert.equal(message.eventId, "evt-sdk-1");
  assert.equal(message.messages[0].content, "来自 SDK");
});

test("unrelated SDK payloads are dropped instead of producing empty turns", () => {
  assert.equal(toEnvelope({ event_type: "im.chat.member.bot.added_v1", message: {} }), null);
  assert.equal(toEnvelope(null), null);
});

test("credentials are required before any connection is attempted", () => {
  assert.throws(() => createSdkConnect({ appId: "cli_x" }), TypeError);
});

test("the connector has the shape the driver calls, and close is safe", () => {
  // A malformed appId makes the SDK refuse to connect, so this exercises the
  // wiring without touching the network.
  const connect = createSdkConnect({ appId: "not-an-app-id", appSecret: "secret", loggerLevel: "fatal" });
  const connection = connect({ onEvent: () => {} });
  assert.equal(typeof connection.close, "function");
  assert.doesNotThrow(() => connection.close());
});
