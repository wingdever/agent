"use strict";

// The one endpoint that mints credentials for a person: authen/v2/oauth/token.
//
// Verified against the live platform: a bad code or refresh token comes back as
// HTTP 400 with {"error":"invalid_grant","error_description":...,"code":20003}
// (20026 for a dead refresh token) -- an OAuth error body, not the usual
// {code:0,data} envelope. So success is detected by the presence of access_token,
// and failure is classified from the OAuth error name.

import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";

export const TOKEN_PATH = "/open-apis/authen/v2/oauth/token";

const AUTH_ERROR = /invalid_grant|invalid_client|unauthorized|invalid_request/i;

/**
 * @param {{baseUrl: string, clientId: string, clientSecret: string, fetchImpl?: Function}} options
 */
export function createTokenClient({ baseUrl, clientId, clientSecret, fetchImpl = globalThis.fetch } = {}) {
  if (!clientId || !clientSecret) throw new TypeError("oauth token client needs clientId and clientSecret");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  async function post(extra) {
    const response = await fetchImpl(baseUrl + TOKEN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...extra }),
    });
    const payload = await response.json().catch(() => ({}));

    if (payload && typeof payload.access_token === "string" && payload.access_token) {
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token || null,
        expiresIn: Number(payload.expires_in) || 0,
        tokenType: payload.token_type || "Bearer",
        scope: payload.scope || "",
      };
    }

    const error = String((payload && payload.error) || "");
    const status = response.status;
    const kind =
      AUTH_ERROR.test(error) || status === 401 || status === 403
        ? ERROR_KINDS.AUTH
        : status === 429 || status >= 500
          ? ERROR_KINDS.RETRYABLE
          : ERROR_KINDS.PLATFORM;
    throw new ChannelError(
      kind,
      `oauth token ${error || (payload && payload.code) || status}: ${(payload && (payload.error_description || payload.msg)) || ""}`.trim(),
      { status, code: payload && payload.code }
    );
  }

  return {
    refresh(refreshToken) {
      return post({ grant_type: "refresh_token", refresh_token: refreshToken });
    },
    exchangeCode({ code, redirectUri }) {
      return post({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    },
  };
}
