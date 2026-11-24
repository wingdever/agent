"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertProxy, proxyProblems, hasScope } from "../../proxies/contract.js";
import { createProxy as createFake } from "../../proxies/fake/index.js";

test("a real driver satisfies the contract", () => {
  const proxy = createFake({ instance: { id: "contract-ok" } });
  assert.doesNotThrow(() => assertProxy(proxy));
  assert.equal(proxyProblems(proxy).length, 0);
});

test("a proxy without a call surface is rejected", () => {
  const proxy = createFake({ instance: { id: "contract-nocall" } });
  delete proxy.call;
  assert.throws(() => assertProxy(proxy), /call must be a function/);
});

test("scopes must be an array of strings, not a free-form claim", () => {
  const proxy = createFake({ instance: { id: "contract-scopes" } });
  proxy.scopes = "doc:read";
  assert.throws(() => assertProxy(proxy), /scopes must be an array/);
});

test("hasScope is the least-privilege check drivers use", () => {
  const proxy = createFake({ instance: { id: "contract-has", scopes: ["doc:read"] } });
  assert.equal(hasScope(proxy, "doc:read"), true);
  assert.equal(hasScope(proxy, "doc:write"), false);
});

test("all problems are reported in one throw", () => {
  assert.ok(proxyProblems({}).length >= 3);
});
