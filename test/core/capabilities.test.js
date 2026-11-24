"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapabilities } from "../../core/capabilities.js";

function fakeProxy(id, scopes = ["docx:document:readonly"]) {
  return { instanceId: id, type: "lark", scopes, whoami: async () => "Fake Wing", call: async () => ({}) };
}

test("no proxies means no capability, and the error names that plainly", () => {
  const capabilities = createCapabilities();
  assert.deepEqual(capabilities.listProxies(), []);
  assert.equal(capabilities.hasProxy("me"), false);
  assert.throws(() => capabilities.proxy("me"), /unknown proxy "me" \(known: none\)/);
});

test("lookup is by instance id, never by order", () => {
  const capabilities = createCapabilities({ proxies: [fakeProxy("a"), fakeProxy("b")] });
  assert.equal(capabilities.proxy("b").instanceId, "b");
  assert.equal(capabilities.proxy("a").instanceId, "a");
  assert.throws(() => capabilities.proxy("0"), /unknown proxy "0" \(known: a, b\)/);
});

test("listing exposes metadata only, so identity checks cost no CLI call", () => {
  const capabilities = createCapabilities({ proxies: [fakeProxy("me", ["drive:drive:readonly"])] });
  assert.deepEqual(capabilities.listProxies(), [
    { instanceId: "me", type: "lark", scopes: ["drive:drive:readonly"] },
  ]);
});

test("a proxy without an id is rejected at composition time, not on first call", () => {
  assert.throws(() => createCapabilities({ proxies: [{ type: "lark" }] }), /needs an instanceId/);
});
