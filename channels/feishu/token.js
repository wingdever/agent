"use strict";

// app_id/app_secret -> tenant_access_token.
//
// The result feeds accounts/auth (strategy appSecretToToken), which owns caching
// and invalidation. This module only knows how to ask; it never decides how long
// a token lives, because the platform's stated expiry is not a promise.

import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";

export const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";

/**
 * @param {{baseUrl: string, appId: string, appSecret: string, fetchImpl?: Function}} options
 * @returns {() => Promise<string>}
 */
export function createTokenFetcher({ baseUrl, appId, appSecret, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  // Credentials are checked at start(), not at construction: a channel instance
  // that is configured but not yet connected must not break app startup. This
  // guard stays because auth.headers() can also be reached without a start.
  return async function fetchToken() {
    if (!appId || !appSecret) {
      throw new ChannelError(ERROR_KINDS.AUTH, "feishu credentials missing: appId and appSecret are required");
    }
    const response = await fetchImpl(baseUrl + TOKEN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });

    if (!response.ok) {
      throw new ChannelError(ERROR_KINDS.AUTH, `feishu token endpoint returned http ${response.status}`, {
        status: response.status,
      });
    }

    const payload = await response.json();
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new ChannelError(ERROR_KINDS.AUTH, `feishu token exchange failed: ${payload.msg || payload.code}`, {
        code: payload.code,
      });
    }
    return payload.tenant_access_token;
  };
}
