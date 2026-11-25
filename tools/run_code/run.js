"use strict";

// run_code: the PTC/executor entry. The tool body only validates the program
// arguments; the node loop injects exec.runCode so nested tools stay on the
// normal permission, approval and cancellation pipeline.

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "./../../lib/code-runner/index.js";

function normalizeTimeout(value) {
  if (value == null) return DEFAULT_TIMEOUT_MS;
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (number <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(number, MAX_TIMEOUT_MS);
}

export default {
  async run(args = {}, exec = {}) {
    if (typeof exec.runCode !== "function") {
      return { text: "Error: run_code is unavailable in this context", isError: true };
    }
    if (typeof args.code !== "string" || !args.code.trim()) {
      return { text: "Error: code must be a non-empty string", isError: true };
    }
    if (typeof args.description !== "string" || !args.description.trim()) {
      return { text: "Error: description must be a non-empty string", isError: true };
    }
    const result = await exec.runCode({
      code: args.code,
      description: args.description,
      timeoutMs: normalizeTimeout(args.timeoutMs),
      signal: exec.signal,
    });
    return result;
  },
};
