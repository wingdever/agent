"use strict";

import test from "node:test";
import assert from "assert/strict";
import net from "node:net";

import {
  AUTHORIZE_PATH,
  buildAuthorizeUrl,
  createConsentCallback,
  ensureOfflineScope,
  OFFLINE_SCOPE,
  runConsent,
} from "../../../proxies/lark/consent.js";
import { createMemoryTokenStore } from "../../../proxies/lark/token-store.js";

const CLIENT_ID = "cli_test_123";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Wait until `predicate` is true on the collected log lines, or time out. */
async function waitFor(lines, predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(lines)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for log output");
}

test("authorize URL points at the v1 path that actually renders", () => {
  const url = buildAuthorizeUrl({
    clientId: CLIENT_ID,
    redirectUri: "http://127.0.0.1:47653/callback",
    state: "s1",
    scopes: ["docx:document:readonly", "drive:drive:readonly"],
  });
  assert.equal(AUTHORIZE_PATH, "/open-apis/authen/v1/authorize");
  assert.ok(url.startsWith(`https://accounts.feishu.cn${AUTHORIZE_PATH}?`));
  const query = new URL(url).searchParams;
  assert.equal(query.get("client_id"), CLIENT_ID);
  assert.equal(query.get("redirect_uri"), "http://127.0.0.1:47653/callback");
  assert.equal(query.get("response_type"), "code");
  assert.equal(query.get("state"), "s1");
  // Space separated, offline_access appended: without it the platform issues no
  // refresh token, which defeats the route.
  assert.equal(query.get("scope"), "docx:document:readonly drive:drive:readonly offline_access");
});

test("offline_access is added once and never duplicated", () => {
  assert.deepEqual(ensureOfflineScope(["a"]), ["a", OFFLINE_SCOPE]);
  assert.deepEqual(ensureOfflineScope(["a", OFFLINE_SCOPE]), ["a", OFFLINE_SCOPE]);
  assert.deepEqual(ensureOfflineScope([]), [OFFLINE_SCOPE]);
  const url = buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: "http://h/cb", state: "s", scopes: [OFFLINE_SCOPE] });
  assert.equal(new URL(url).searchParams.get("scope"), OFFLINE_SCOPE);
});

test("authorize URL refuses to build without the required parameters", () => {
  assert.throws(() => buildAuthorizeUrl({ redirectUri: "http://h/cb", state: "s" }), /clientId/);
  assert.throws(() => buildAuthorizeUrl({ clientId: CLIENT_ID, state: "s" }), /redirectUri/);
  assert.throws(() => buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: "http://h/cb" }), /state/);
});

test("callback resolves the code and answers the browser", async () => {
  const callback = createConsentCallback({ state: "abc" });
  const { url } = await callback.listen();
  const waited = callback.wait();
  const response = await fetch(`${url}?code=the-code&state=abc`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /approved/);
  assert.deepEqual(await waited, { code: "the-code", state: "abc" });
  await callback.close();
});

test("callback rejects a state mismatch instead of accepting someone else's code", async () => {
  const callback = createConsentCallback({ state: "abc" });
  const { url } = await callback.listen();
  const waited = callback.wait();
  const response = await fetch(`${url}?code=injected&state=wrong`);
  assert.equal(response.status, 400);
  await assert.rejects(waited, /state mismatch/);
  await callback.close();
});

test("callback surfaces an explicit denial", async () => {
  const callback = createConsentCallback({ state: "abc" });
  const { url } = await callback.listen();
  const waited = callback.wait();
  await fetch(`${url}?error=access_denied&state=abc`);
  await assert.rejects(waited, /access_denied/);
  await callback.close();
});

test("callback ignores unrelated paths and times out on its own", async () => {
  const callback = createConsentCallback({ state: "abc", timeoutMs: 60 });
  const { url } = await callback.listen();
  const waited = callback.wait();
  const response = await fetch(`${url.replace("/callback", "/favicon.ico")}`);
  assert.equal(response.status, 404);
  await assert.rejects(waited, /no authorization callback/);
  await callback.close();
});

test("runConsent exchanges the code, saves tokens and keeps secrets out of the log", async () => {
  const port = await freePort();
  const lines = [];
  const store = createMemoryTokenStore();
  const saved = [];

  const exchangeCalls = [];
  const tokenClient = {
    async exchangeCode(args) {
      exchangeCalls.push(args);
      return { accessToken: "at_secret", refreshToken: "rt_secret", expiresIn: 7200, tokenType: "Bearer", scope: "docx:document:readonly offline_access" };
    },
  };

  const done = runConsent({
    clientId: CLIENT_ID,
    clientSecret: "secret",
    scopes: ["docx:document:readonly"],
    store: { ...store, save: async (tokens) => { saved.push(tokens); await store.save(tokens); } },
    port,
    tokenClient,
    log: (line) => lines.push(line),
    now: () => 1_700_000_000_000,
  });
  done.catch(() => {});

  await waitFor(lines, (all) => all.some((line) => line.includes("open-apis/authen/v1/authorize")));
  const urlLine = lines.find((line) => line.includes("open-apis/authen/v1/authorize"));
  const authorize = new URL(urlLine.trim());
  const state = authorize.searchParams.get("state");
  const redirectUri = authorize.searchParams.get("redirect_uri");

  const response = await fetch(`${redirectUri}?code=code-1&state=${state}`);
  assert.equal(response.status, 200);

  const result = await done;
  assert.equal(result.hasRefreshToken, true);
  assert.equal(result.expiresAt, 1_700_000_000_000 + 7200 * 1000);
  assert.deepEqual(exchangeCalls, [{ code: "code-1", redirectUri }]);
  assert.equal(saved.length, 1);
  assert.equal(store.snapshot().refreshToken, "rt_secret");
  assert.equal(store.snapshot().obtainedAt, 1_700_000_000_000);

  // A refresh token in terminal scrollback is a leak; the flow must not echo it.
  assert.ok(!lines.join("\n").includes("rt_secret"));
  assert.ok(!lines.join("\n").includes("at_secret"));
});

test("runConsent reports a grant without refresh token instead of pretending success", async () => {
  const port = await freePort();
  const lines = [];
  const store = createMemoryTokenStore();
  const done = runConsent({
    clientId: CLIENT_ID,
    scopes: [],
    store,
    port,
    tokenClient: { exchangeCode: async () => ({ accessToken: "at_only", refreshToken: null, expiresIn: 600 }) },
    log: (line) => lines.push(line),
  });
  done.catch(() => {});
  await waitFor(lines, (all) => all.some((line) => line.includes("open-apis/authen/v1/authorize")));
  const authorize = new URL(lines.find((line) => line.includes("open-apis/authen/v1/authorize")).trim());
  await fetch(`${authorize.searchParams.get("redirect_uri")}?code=c&state=${authorize.searchParams.get("state")}`);
  const result = await done;
  assert.equal(result.hasRefreshToken, false);
  assert.equal(store.snapshot().accessToken, "at_only");
});

test("runConsent rejects an exchange that returns no access token", async () => {
  const port = await freePort();
  const lines = [];
  const done = runConsent({
    clientId: CLIENT_ID,
    scopes: [],
    store: createMemoryTokenStore(),
    port,
    tokenClient: { exchangeCode: async () => ({ refreshToken: "rt_x" }) },
    log: (line) => lines.push(line),
  });
  done.catch(() => {});
  await waitFor(lines, (all) => all.some((line) => line.includes("open-apis/authen/v1/authorize")));
  const authorize = new URL(lines.find((line) => line.includes("open-apis/authen/v1/authorize")).trim());
  await fetch(`${authorize.searchParams.get("redirect_uri")}?code=c&state=${authorize.searchParams.get("state")}`);
  await assert.rejects(done, /no access_token/);
});
