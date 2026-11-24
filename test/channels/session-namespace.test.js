"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionIdFor, parseSessionId, SESSION_PREFIX } from "../../channels/session-namespace.js";

test("session id carries type, instance and conversation", () => {
  const id = sessionIdFor({ type: "feishu", instanceId: "main", conversationKey: "oc_123" });
  assert.equal(id, "ch:feishu:main:oc_123");
  assert.deepEqual(parseSessionId(id), { type: "feishu", instanceId: "main", conversationKey: "oc_123" });
});

test("two instances never share a session for the same conversation", () => {
  const a = sessionIdFor({ type: "feishu", instanceId: "bot-a", conversationKey: "oc_1" });
  const b = sessionIdFor({ type: "feishu", instanceId: "bot-b", conversationKey: "oc_1" });
  assert.notEqual(a, b);
});

test("conversation keys containing ':' survive the round trip", () => {
  const key = "dm:ou_1:ou_2";
  assert.deepEqual(parseSessionId(sessionIdFor({ type: "qq", instanceId: "q1", conversationKey: key })), {
    type: "qq",
    instanceId: "q1",
    conversationKey: key,
  });
});

test("missing or ambiguous parts are refused", () => {
  assert.throws(() => sessionIdFor({ type: "", instanceId: "x", conversationKey: "y" }), /non-empty type/);
  assert.throws(() => sessionIdFor({ type: "a:b", instanceId: "x", conversationKey: "y" }), /must not contain/);
  assert.throws(() => parseSessionId("core:abc"), /not a channel session id/);
});

test("prefix is stable because it is stored in the db", () => {
  assert.equal(SESSION_PREFIX, "ch");
});
