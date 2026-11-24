"use strict";

// Outbound queue: rate limit, retry, credential recovery.
//
// Every external platform meters outbound calls (QPS caps, daily proactive
// message quotas). Exceeding them is not a corner case, it is the normal
// steady state on a busy group, so pacing and retry live in the shared layer
// instead of being re-implemented by each driver.

import { ERROR_KINDS, classifyError, ChannelError } from "./../errors.js";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Object} options
 * @param {number} [options.qps] outbound calls per second for this instance
 * @param {number} [options.maxAttempts] attempts per send, including the first
 * @param {number} [options.backoffMs] base backoff for retryable failures
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable for tests
 * @param {() => number} [options.now] injectable clock
 * @param {{invalidate: () => Promise<void>}} [options.auth] invalidation hook
 */
export function createOutboundQueue({
  qps = 1,
  maxAttempts = 3,
  backoffMs = 200,
  sleep = defaultSleep,
  now = Date.now,
  auth = null,
} = {}) {
  if (!Number.isFinite(qps) || qps <= 0) throw new TypeError("qps must be a positive finite number");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError("maxAttempts must be a positive integer");

  const minIntervalMs = Math.ceil(1000 / qps);
  const stats = { sent: 0, retried: 0, reauthenticated: 0, failed: 0 };
  let lastSentAt = -Infinity;
  let tail = Promise.resolve();

  /**
   * Enqueue one send. Sends run serially: a token bucket with one lane keeps
   * the pacing honest and keeps platform call order stable.
   * @template T
   * @param {() => Promise<T>} sendFn
   * @returns {Promise<T>}
   */
  function push(sendFn) {
    if (typeof sendFn !== "function") throw new TypeError("push requires a function");
    const result = tail.then(() => execute(sendFn));
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async function execute(sendFn) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const gap = now() - lastSentAt;
      if (gap < minIntervalMs) await sleep(minIntervalMs - gap);
      lastSentAt = now();
      try {
        const value = await sendFn();
        stats.sent++;
        return value;
      } catch (err) {
        lastError = err;
        const kind = classifyError(err);
        // `rotates === false` means the credential cannot be renewed: retrying
        // the same dead token only spends another request on a certain failure.
        if (kind === ERROR_KINDS.AUTH && auth && auth.rotates !== false) {
          // Credential is dead: refresh once, then let the attempt counter decide.
          stats.reauthenticated++;
          await auth.invalidate();
          continue;
        }
        if (kind === ERROR_KINDS.RETRYABLE && attempt < maxAttempts) {
          stats.retried++;
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }
        stats.failed++;
        throw err instanceof ChannelError
          ? err
          : new ChannelError(kind, String((err && err.message) || err), { cause: err });
      }
    }
    stats.failed++;
    throw lastError instanceof ChannelError
      ? lastError
      : new ChannelError(classifyError(lastError), String((lastError && lastError.message) || lastError), {
          cause: lastError,
        });
  }

  return { push, stats, minIntervalMs, idle: () => tail };
}
