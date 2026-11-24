"use strict";

// OAuth user token with silent refresh.
//
// Two properties this exists for:
//   1. The refresh token rotates. A refresh that succeeds but whose new pair is
//      not persisted leaves the next process with a dead grant, so `onTokens`
//      is a required hook, not a convenience.
//   2. Refresh must be single-flight. N concurrent calls with an expired token
//      would otherwise rotate the refresh token N times, and only the last one
//      survives -- the others are already invalid on arrival.

import { ChannelError, ERROR_KINDS } from "./../errors.js";

/**
 * @param {Object} options
 * @param {{accessToken?: string, refreshToken?: string, expiresAt?: number}} [options.tokens]
 * @param {(args: {refreshToken: string}) => Promise<{accessToken: string, refreshToken?: string, expiresIn?: number}>} options.refresh
 * @param {(tokens: {accessToken: string, refreshToken: string, expiresAt: number}) => Promise<void>} [options.onTokens]
 * @param {number} [options.cacheSkewMs] refresh this long before the stated expiry
 * @param {() => number} [options.now]
 */
export function createOAuthRefreshAuth({
  tokens = {},
  refresh,
  onTokens = null,
  cacheSkewMs = 60 * 1000,
  now = Date.now,
} = {}) {
  if (typeof refresh !== "function") throw new TypeError("refresh must be a function");
  if (onTokens !== null && typeof onTokens !== "function") throw new TypeError("onTokens must be a function");

  let current = normalize(tokens);
  /** @type {Promise<Object>|null} */
  let pending = null;

  function normalize(value) {
    return {
      accessToken: (value && value.accessToken) || null,
      refreshToken: (value && value.refreshToken) || null,
      expiresAt: Number((value && value.expiresAt) || 0) || 0,
    };
  }

  function isFresh(candidate = current) {
    if (!candidate.accessToken) return false;
    if (!candidate.expiresAt) return true; // unknown lifetime: trust the token until rejected
    return now() < candidate.expiresAt - cacheSkewMs;
  }

  async function reacquire() {
    if (!current.refreshToken) {
      throw new ChannelError(ERROR_KINDS.AUTH, "no refresh_token: the grant needs re-authorization");
    }
    const granted = await refresh({ refreshToken: current.refreshToken });
    if (!granted || typeof granted.accessToken !== "string" || !granted.accessToken) {
      throw new ChannelError(ERROR_KINDS.AUTH, "refresh returned no access_token");
    }
    const expiresIn = Number(granted.expiresIn);
    const next = {
      accessToken: granted.accessToken,
      // Platforms that do not rotate omit the field; keeping the old one is the
      // only sane default.
      refreshToken: granted.refreshToken || current.refreshToken,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : 0,
    };
    current = next;
    if (onTokens) await onTokens({ ...next });
    return current;
  }

  return {
    async headers() {
      if (!isFresh()) {
        if (!pending) {
          pending = reacquire().finally(() => {
            pending = null;
          });
        }
        await pending;
      }
      return { Authorization: `Bearer ${current.accessToken}` };
    },

    async invalidate() {
      // Drop the access token but keep the refresh token: that is the whole point.
      current = { ...current, accessToken: null, expiresAt: 0 };
    },

    // --- introspection for tests and diagnostics ---------------------------
    snapshot: () => ({ ...current }),
    isFresh,
  };
}
