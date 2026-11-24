"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOAuthRefreshAuth, createAuth } from "../../../accounts/auth/index.js";
import { ChannelError, ERROR_KINDS } from "../../../accounts/errors.js";

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

function refresher({ rotate = true } = {}) {
  const calls = [];
  const saved = [];
  return {
    calls,
    saved,
    refresh: async ({ refreshToken }) => {
      calls.push(refreshToken);
      const n = calls.length;
      return { accessToken: `at_${n}`, refreshToken: rotate ? `rt_${n}` : undefined, expiresIn: 7200 };
    },
    onTokens: async (tokens) => saved.push(tokens),
  };
}

test("a fresh token is used as-is: no refresh on every call", async () => {
  const c = clock();
  const r = refresher();
  const auth = createOAuthRefreshAuth({ tokens: { accessToken: "at_0", expiresAt: c.now() + 7200_000 }, refresh: r.refresh, now: c.now });

  assert.equal((await auth.headers()).Authorization, "Bearer at_0");
  assert.equal(r.calls.length, 0);
});

test("an expired token triggers exactly one refresh, and the rotated pair is persisted", async () => {
  const c = clock();
  const r = refresher();
  const auth = createOAuthRefreshAuth({ tokens: { accessToken: "at_0", refreshToken: "rt_0", expiresAt: c.now() - 1 }, refresh: r.refresh, onTokens: r.onTokens, now: c.now });

  assert.equal((await auth.headers()).Authorization, "Bearer at_1");
  assert.deepEqual(r.calls, ["rt_0"]);
  assert.deepEqual(r.saved, [{ accessToken: "at_1", refreshToken: "rt_1", expiresAt: c.now() + 7200_000 }]);
  assert.equal((await auth.headers()).Authorization, "Bearer at_1", "the new token is cached");
  assert.equal(r.calls.length, 1);
});

test("concurrent callers share one refresh, so the refresh token rotates once", async () => {
  const c = clock();
  const r = refresher();
  const auth = createOAuthRefreshAuth({ tokens: { accessToken: "at_0", refreshToken: "rt_0", expiresAt: c.now() - 1 }, refresh: r.refresh, now: c.now });

  const results = await Promise.all([auth.headers(), auth.headers(), auth.headers()]);
  assert.deepEqual(results.map((h) => h.Authorization), ["Bearer at_1", "Bearer at_1", "Bearer at_1"]);
  assert.equal(r.calls.length, 1, "three callers must not rotate the grant three times");
});

test("invalidate drops the access token but keeps the refresh token", async () => {
  const c = clock();
  const r = refresher();
  const auth = createOAuthRefreshAuth({ tokens: { accessToken: "at_0", refreshToken: "rt_0", expiresAt: c.now() + 7200_000 }, refresh: r.refresh, now: c.now });

  await auth.invalidate();
  assert.equal(auth.snapshot().refreshToken, "rt_0");
  assert.equal((await auth.headers()).Authorization, "Bearer at_1");
});

test("a platform that does not rotate keeps the existing refresh token", async () => {
  const c = clock();
  const r = refresher({ rotate: false });
  const auth = createOAuthRefreshAuth({ tokens: { accessToken: "at_0", refreshToken: "rt_0", expiresAt: c.now() - 1 }, refresh: r.refresh, onTokens: r.onTokens, now: c.now });

  await auth.headers();
  assert.equal(r.saved[0].refreshToken, "rt_0");
  assert.equal(auth.snapshot().refreshToken, "rt_0");
});

test("a dead grant fails as auth, and says re-authorization is needed", async () => {
  const auth = createOAuthRefreshAuth({ tokens: { accessToken: "at_0", expiresAt: 0 }, refresh: async () => ({}) });
  await auth.invalidate();
  await assert.rejects(auth.headers(), (err) => {
    assert.ok(err instanceof ChannelError);
    assert.equal(err.kind, ERROR_KINDS.AUTH);
    assert.match(err.message, /no refresh_token/);
    return true;
  });
});

test("a refresh that returns nothing usable is an auth failure too", async () => {
  const auth = createOAuthRefreshAuth({ tokens: { refreshToken: "rt_0" }, refresh: async () => ({}) });
  await assert.rejects(auth.headers(), /refresh returned no access_token/);
});

test("the strategy is reachable through createAuth('oauthRefresh')", async () => {
  const auth = createAuth({
    strategy: "oauthRefresh",
    credentials: { refreshToken: "rt_0" },
    deps: { refresh: async () => ({ accessToken: "at_9", expiresIn: 60 }), now: () => 0 },
  });
  assert.equal((await auth.headers()).Authorization, "Bearer at_9");
});
