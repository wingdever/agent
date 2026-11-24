"use strict";

// One-time consent: turn a human clicking "approve" into a long-lived grant.
//
// The oauth route can refresh forever, but it cannot start from nothing: the first
// refresh token only exists after someone opens a browser and approves. That step
// cannot be automated (it is a human decision), so it is a local, run-once helper
// that prints a URL, waits for the loopback callback and writes the token file.
//
// Two facts here come from probing the live platform, not from the docs:
//
//   1. The browser consent page is the **v1** path on accounts.feishu.cn
//      (`/open-apis/authen/v1/authorize`). The v2 path
//      (`/open-apis/authen/v2/authorize`) returns 404 on both accounts.feishu.cn
//      and open.feishu.cn, even though the v2 token endpoint works. So the
//      authorize URL and the token URL live on different versions.
//   2. A refresh token is only issued if the app was granted `offline_access`.
//      Without it the exchange still succeeds, but returns no refresh token --
//      which silently turns the "deployable" route back into a one-shot token.
//      So `offline_access` is appended to every authorize URL instead of being
//      left to the caller to remember.

import crypto from "crypto";
import http from "http";
import { createTokenClient } from "./oauth-token.js";

export const DEFAULT_ACCOUNTS_BASE = "https://accounts.feishu.cn";
export const AUTHORIZE_PATH = "/open-apis/authen/v1/authorize";
export const OFFLINE_SCOPE = "offline_access";

/** Scope list used by the consent page: platform scopes plus `offline_access`. */
export function ensureOfflineScope(scopes = []) {
  const list = scopes.map(String).filter(Boolean);
  return list.includes(OFFLINE_SCOPE) ? list : [...list, OFFLINE_SCOPE];
}

/**
 * @param {{clientId: string, redirectUri: string, state: string, scopes?: string[], accountsBase?: string}} options
 * @returns {string}
 */
export function buildAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  scopes = [],
  accountsBase = DEFAULT_ACCOUNTS_BASE,
} = {}) {
  if (!clientId) throw new TypeError("buildAuthorizeUrl needs clientId");
  if (!redirectUri) throw new TypeError("buildAuthorizeUrl needs redirectUri");
  if (!state) throw new TypeError("buildAuthorizeUrl needs state");

  const query = new URLSearchParams({
    client_id: String(clientId),
    redirect_uri: String(redirectUri),
    response_type: "code",
    state: String(state),
    scope: ensureOfflineScope(scopes).join(" "),
  });
  return `${accountsBase}${AUTHORIZE_PATH}?${query.toString()}`;
}

/**
 * Loopback server that receives `?code=&state=`. Binds 127.0.0.1 only: the code
 * is a credential and must not be reachable from the network.
 *
 * @param {{port?: number, path?: string, state: string, host?: string, timeoutMs?: number}} options
 */
export function createConsentCallback({
  port = 0,
  path = "/callback",
  state,
  host = "127.0.0.1",
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (!state) throw new TypeError("createConsentCallback needs state");

  let server = null;
  let url = "";
  let timer = null;
  let settled = false;
  let resolveWait;
  let rejectWait;

  const waited = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  // The promise is awaited later; an early client-side close must not surface
  // as an unhandled rejection.
  waited.catch(() => {});

  function settle(fn, value) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn(value);
  }

  function respond(res, status, text) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
    res.end(text);
  }

  function onRequest(req, res) {
    const requestUrl = new URL(req.url, `http://${host}`);
    if (requestUrl.pathname !== path) {
      respond(res, 404, "not found");
      return;
    }
    const params = requestUrl.searchParams;
    const error = params.get("error");
    if (error) {
      respond(res, 200, `authorization failed: ${error}. You can close this tab.`);
      settle(rejectWait, new Error(`authorization denied: ${error}`));
      return;
    }
    // state is the only thing that ties the callback to the URL this process
    // printed; without the check any local page could inject its own code.
    if ((params.get("state") || "") !== state) {
      respond(res, 400, "state mismatch");
      settle(rejectWait, new Error("state mismatch in the authorization callback"));
      return;
    }
    const code = params.get("code");
    if (!code) {
      respond(res, 400, "missing code");
      settle(rejectWait, new Error("authorization callback carried no code"));
      return;
    }
    respond(res, 200, "approved. You can close this tab and return to the terminal.");
    settle(resolveWait, { code, state });
  }

  return {
    /** Start listening and return the redirect URI to register/print. */
    async listen() {
      server = http.createServer(onRequest);
      server.keepAliveTimeout = 0;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const actual = server.address();
      url = `http://${host}:${actual.port}${path}`;
      return { url, port: actual.port };
    },

    /** Resolve with the authorization code, or reject on denial, mismatch or timeout. */
    wait() {
      timer = setTimeout(
        () => settle(rejectWait, new Error(`no authorization callback within ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs
      );
      timer.unref?.();
      return waited;
    },

    /** Stop listening. Safe to call twice. */
    async close() {
      settled = true;
      if (timer) clearTimeout(timer);
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise((resolve) => {
        try {
          closing.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
    },

    get url() {
      return url;
    },
  };
}

/**
 * Full flow: print URL, wait for the callback, exchange the code, persist tokens.
 *
 * @param {Object} options
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {string[]} [options.scopes]
 * @param {Object} options.store token store (see token-store.js)
 * @param {number} [options.port]
 * @param {string} [options.path]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.baseUrl] open platform base, for the token endpoint
 * @param {string} [options.accountsBase]
 * @param {Function} [options.fetchImpl]
 * @param {Object} [options.tokenClient] injected client (tests)
 * @param {Function} [options.log]
 * @param {Function} [options.now]
 */
export async function runConsent({
  clientId,
  clientSecret,
  scopes = [],
  store,
  port = 0,
  path = "/callback",
  timeoutMs = 10 * 60 * 1000,
  baseUrl = "https://open.feishu.cn",
  accountsBase = DEFAULT_ACCOUNTS_BASE,
  fetchImpl,
  tokenClient,
  log = () => {},
  now = Date.now,
} = {}) {
  if (!store || typeof store.save !== "function") throw new TypeError("runConsent needs a token store");
  if (!clientId) throw new TypeError("runConsent needs clientId");
  if (!tokenClient && !clientSecret) throw new TypeError("runConsent needs clientSecret (or an injected tokenClient)");

  const state = crypto.randomBytes(16).toString("hex");
  const callback = createConsentCallback({ port, path, state, timeoutMs });
  const { url: redirectUri } = await callback.listen();
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state, scopes, accountsBase });

  const client = tokenClient || createTokenClient({ baseUrl, clientId, clientSecret, fetchImpl });

  log(`redirect_uri (must be registered on the app): ${redirectUri}`);
  log("open this URL in a browser on any machine (the URL is on the next line):");
  log(authorizeUrl);

  try {
    const { code } = await callback.wait();
    const tokens = await client.exchangeCode({ code, redirectUri });
    if (!tokens || !tokens.accessToken) throw new Error("token exchange returned no access_token");

    const obtainedAt = now();
    const record = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || null,
      expiresAt: tokens.expiresIn ? obtainedAt + Number(tokens.expiresIn) * 1000 : 0,
      tokenType: tokens.tokenType || "Bearer",
      scope: tokens.scope || "",
      obtainedAt,
    };
    await store.save(record);

    return {
      redirectUri,
      expiresAt: record.expiresAt,
      scope: record.scope,
      hasRefreshToken: Boolean(record.refreshToken),
    };
  } finally {
    await callback.close();
  }
}
