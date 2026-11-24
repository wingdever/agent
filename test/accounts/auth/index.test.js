"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuth, createStaticAuth, createAppSecretTokenAuth } from "../../../accounts/auth/index.js";

test("static credentials are returned verbatim", async () => {
  const auth = createStaticAuth({ Authorization: "Bearer abc" });
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer abc" });
});

test("a bearer token in config becomes an authorization header", async () => {
  const auth = createAuth({ strategy: "static", credentials: { token: "abc" } });
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer abc" });
});

test("the exchanged token is cached and only re-acquired after invalidate", async () => {
  let calls = 0;
  const auth = createAppSecretTokenAuth({
    fetchToken: async () => {
      calls++;
      return `t${calls}`;
    },
    cacheMs: 1000,
  });

  assert.deepEqual(await auth.headers(), { Authorization: "Bearer t1" });
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer t1" });
  assert.equal(calls, 1);

  await auth.invalidate();
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer t2" });
  assert.equal(calls, 2);
});

test("the cached token expires on its own after cacheMs", async () => {
  let t = 0;
  let calls = 0;
  const auth = createAppSecretTokenAuth({
    fetchToken: async () => {
      calls++;
      return `t${calls}`;
    },
    cacheMs: 1000,
    now: () => t,
  });

  await auth.headers();
  t = 1500;
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer t2" });
});

test("an unknown strategy is refused instead of silently going unauthenticated", () => {
  assert.throws(() => createAuth({ strategy: "magic" }), /unknown auth strategy/);
});

test("appSecretToToken without a fetchToken is refused", () => {
  assert.throws(() => createAuth({ strategy: "appSecretToToken" }), /fetchToken must be a function/);
});
