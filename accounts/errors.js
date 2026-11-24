"use strict";

// Error taxonomy shared by every channel driver.
//
// A driver should not have to decide whether a failure is worth retrying: it
// raises the platform's own error (or wraps it), and the shared layer maps it
// to one of four dispositions. Token expiry in particular must be handled in
// exactly one place - every driver inventing its own refresh path is how you
// get four subtly different bugs.

export const ERROR_KINDS = Object.freeze({
  RETRYABLE: "retryable", // transient: quota, upstream 5xx, network blip
  AUTH: "auth",           // credential dead: invalidate and re-acquire once
  PLATFORM: "platform",   // platform refused the request: do not retry
  CONTENT: "content",     // payload rejected by size/shape: re-segment
});

// Platform codes that mean "the credential is no longer valid". Values come
// from the documented error tables of the platforms we integrate.
const AUTH_CODES = new Set([
  40014, // feishu: invalid access token
  99991661, // feishu: tenant token missing
  99991663, // feishu: tenant token invalid
  99991668, // feishu: token expired
]);

const CONTENT_PATTERN = /too long|too large|exceed|out of (range|size)/i;

// Platform codes that mean "you are going too fast, come back later". They
// arrive with HTTP 200 and a non-zero `code`, so the status-based mapping below
// never sees them; without this set they would be classified as a hard refusal
// and a bot replying to a fresh message would silently fail (measured: feishu
// answers a bot's first card right after an event with 230429).
const THROTTLE_CODES = new Set([
  230429, // feishu im: "This operation triggers the frequency limit"
  99991400, // feishu open platform: request rate limit
  11232, // feishu: too many requests
]);

/** True when a platform error code means the credential is dead. */
export function isAuthCode(code) {
  return AUTH_CODES.has(Number(code));
}

/** True when a platform error code means rate limiting rather than a refusal. */
export function isThrottleCode(code) {
  return THROTTLE_CODES.has(Number(code));
}

export class ChannelError extends Error {
  constructor(kind, message, { status, code, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChannelError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/**
 * Map any thrown value to one of ERROR_KINDS.
 * @param {unknown} err
 * @returns {"retryable"|"auth"|"platform"|"content"}
 */
export function classifyError(err) {
  if (err instanceof ChannelError && err.kind) return err.kind;

  const status = Number(err && (err.status || err.statusCode || err.httpCode));
  const code = Number(err && (err.code || (err.response && err.response.code)));
  const message = String((err && err.message) || err || "");

  if (status === 401 || status === 403) return ERROR_KINDS.AUTH;
  if (AUTH_CODES.has(code)) return ERROR_KINDS.AUTH;
  if (THROTTLE_CODES.has(code)) return ERROR_KINDS.RETRYABLE;
  if (status === 429) return ERROR_KINDS.RETRYABLE;
  if (Number.isFinite(status) && status >= 500) return ERROR_KINDS.RETRYABLE;
  if (CONTENT_PATTERN.test(message)) return ERROR_KINDS.CONTENT;
  return ERROR_KINDS.PLATFORM;
}

/** True when another attempt is allowed for this error kind. */
export function isRetryable(err) {
  const kind = classifyError(err);
  return kind === ERROR_KINDS.RETRYABLE || kind === ERROR_KINDS.AUTH;
}
