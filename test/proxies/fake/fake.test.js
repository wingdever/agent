"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createProxy as createFake, KNOWN_ACTIONS } from "../../../proxies/fake/index.js";
import { assertProxy } from "../../../proxies/contract.js";

test("the fake proxy is a valid proxy", () => {
  const proxy = createFake({ instance: { id: "human-a", scopes: ["doc:read"] } });
  assertProxy(proxy);
  assert.equal(proxy.type, "fake");
  assert.equal(proxy.instanceId, "human-a");
  assert.deepEqual(proxy.scopes, ["doc:read"]);
});

test("whoami names the person the grant belongs to", async () => {
  const proxy = createFake({ instance: { id: "who", who: "wingdever" } });
  assert.equal(await proxy.whoami(), "wingdever");
});

test("an action inside the granted scope runs", async () => {
  const proxy = createFake({ instance: { id: "ok", scopes: ["doc:read"] } });
  const result = await proxy.call("doc.read", { path: "/docs/a" });
  assert.deepEqual(result, { path: "/docs/a", content: "# fake document" });
  assert.equal(proxy.calls.length, 1);
});

test("an action outside the granted scope never reaches the platform", async () => {
  const proxy = createFake({ instance: { id: "scope", scopes: ["doc:read"] } });
  await assert.rejects(() => proxy.call("doc.write", { path: "/docs/a" }), /scope "doc:write" is not granted/);
  assert.equal(proxy.calls.length, 0);
});

test("an unknown action is refused", async () => {
  const proxy = createFake({ instance: { id: "unknown", scopes: ["doc:read"] } });
  await assert.rejects(() => proxy.call("doc.delete", {}), /unknown action "doc.delete"/);
  assert.ok(KNOWN_ACTIONS.includes("doc.read"));
});

test("an expired user token is invalidated and the call retried", async () => {
  const proxy = createFake({ instance: { id: "auth", scopes: ["doc:read"] } });
  proxy.failNextAuth();
  const result = await proxy.call("doc.read", { path: "/docs/b" });
  assert.equal(result.path, "/docs/b");
  assert.equal(proxy.invalidations, 1);
  assert.equal(proxy.calls.length, 1);
});

test("scopes default to read-only when the instance declares none", () => {
  const proxy = createFake({ instance: { id: "default" } });
  assert.deepEqual(proxy.scopes, ["doc:read"]);
});
