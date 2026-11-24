"use strict";

// Credential lifecycle strategies.
//
// These differ per platform far more than anything else in a channel: a static
// secret, an app secret exchanged for a short lived tenant token, an OAuth pair
// that needs silent refresh, a cookie session that expires unpredictably. Drivers
// ask auth.headers() and call auth.invalidate() on rejection; nothing else.

import { createOAuthRefreshAuth } from "./oauth-refresh.js";

export { createOAuthRefreshAuth };

/**
 * Static credential: whatever header set the config carries.
 * @param {Record<string,string>} headers
 */
export function createStaticAuth(headers = {}) {
  const frozen = { ...headers };
  return {
    // A fixed credential cannot be refreshed. Saying so lets the outbound queue
    // skip its "invalidate then retry" step, which for a static secret is a
    // guaranteed second failure and a wasted request.
    rotates: false,
    async headers() {
      return { ...frozen };
    },
    async invalidate() {},
  };
}

/**
 * App secret exchanged for a bearer token (feishu tenant_access_token shape).
 * The token is cached until expiry; invalidate() drops it so the next call
 * re-acquires. Refresh happens in exactly this one place.
 *
 * @param {Object} options
 * @param {() => Promise<string>} options.fetchToken
 * @param {number} [options.cacheMs] conservative lifetime, shorter than the real one
 * @param {() => number} [options.now]
 */
export function createAppSecretTokenAuth({
  fetchToken,
  cacheMs = 90 * 60 * 1000,
  now = Date.now,
  headerName = "Authorization",
  format = (token) => `Bearer ${token}`,
  expiryMarginMs = 60 * 1000,
} = {}) {
  if (typeof fetchToken !== "function") throw new TypeError("fetchToken must be a function");
  let cached = null;

  return {
    async headers() {
      if (!cached || now() >= cached.until) {
        const acquired = await fetchToken();
        if (!acquired) throw new TypeError("fetchToken returned no token");
        // A platform that reports its own lifetime (QQ's `expires_in`) must be
        // believed over a guessed cacheMs: refreshing too late is an outage, too
        // early is just an extra request.
        const token = typeof acquired === "string" ? acquired : acquired.token;
        const ttl = typeof acquired === "string" ? cacheMs : acquired.expiresInMs;
        if (!token) throw new TypeError("fetchToken returned no token");
        // Strings mean "the driver only knows a token, so trust cacheMs verbatim";
        // an object means the platform told us a lifetime, and we shave a margin.
        const lifetime =
          typeof acquired === "string" || !Number.isFinite(ttl) ? cacheMs : Math.max(ttl - expiryMarginMs, 60 * 1000);
        cached = { token, until: now() + lifetime };
      }
      return { [headerName]: format(cached.token) };
    },
    async invalidate() {
      cached = null;
    },
    _cached: () => cached,
  };
}

/**
 * @param {Object} options
 * @param {"static"|"appSecretToToken"} [options.strategy]
 * @param {Record<string,string>} [options.credentials]
 * @param {Object} [options.deps]
 */
export function createAuth({ strategy = "static", credentials = {}, deps = {} } = {}) {
  switch (strategy) {
    case "static": {
      const headers =
        credentials.headers ||
        (credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {});
      return createStaticAuth(headers);
    }
    case "appSecretToToken":
      return createAppSecretTokenAuth({
        fetchToken: deps.fetchToken,
        cacheMs: deps.tokenCacheMs,
        now: deps.now,
      });
    case "oauthRefresh":
      return createOAuthRefreshAuth({
        tokens: deps.tokens || {
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt,
        },
        refresh: deps.refresh,
        onTokens: deps.onTokens,
        cacheSkewMs: deps.cacheSkewMs,
        now: deps.now,
      });
    default:
      throw new TypeError(`unknown auth strategy "${strategy}"`);
  }
}
