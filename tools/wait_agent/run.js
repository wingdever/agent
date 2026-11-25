"use strict";

// wait_agent: block the current tool call until the caller's own nextStep
// queue has input that this step has not reported yet. It does not consume:
// pre-step claims the queue at the actual step boundary.

async function run(args = {}, exec = {}) {
  if (typeof exec.waitAgent !== "function") {
    return { text: "Error: wait_agent is unavailable in this context", isError: true };
  }
  const timeoutMs = args.timeout_ms == null ? 30000 : args.timeout_ms;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 3600000) {
    return { text: "Error: timeout_ms must be an integer between 10000 and 3600000", isError: true };
  }
  const result = await exec.waitAgent({ timeoutMs, signal: exec.signal });
  return {
    text: JSON.stringify({ timedOut: result.timedOut === true }),
    meta: { timedOut: result.timedOut === true, pending: result.pending || 0 },
  };
}

const __exports = { run };
export { run };
export default __exports;
