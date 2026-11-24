"use strict";

// Run the lark-cli binary and turn its output into data or a typed error.
//
// One behavior matters more than the rest: lark-cli exits 0 even when the API call
// failed. Failures arrive as { ok: false, error: {...} } on stdout, so a proxy that
// trusts the exit code will happily treat "403 permission denied" as success.

import { spawn } from "child_process";
import { ChannelError, ERROR_KINDS, isAuthCode } from "./../../accounts/errors.js";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Subtypes that mean "the human credential is dead", not "the request was wrong". */
const AUTH_SUBTYPE = /^(auth|unauthor|token)/i;
const RETRY_SUBTYPE = /^rate|^server|^timeout/i;

/**
 * @param {{command?: string, prefixArgs?: string[], timeoutMs?: number, env?: Object,
 *         spawnImpl?: Function}} [options]
 */
export function createCliRunner({
  command = "lark-cli",
  prefixArgs = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = null,
  spawnImpl = spawn,
} = {}) {
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl must be a function");

  function targetEnv() {
    return env ? { ...process.env, ...env } : process.env;
  }

  /**
   * @param {string[]} args
   * @param {{dryRun?: boolean, timeoutMs?: number}} [options]
   * @returns {Promise<Object>} the CLI's JSON payload
   */
  function run(args, { dryRun = false, timeoutMs: timeout = timeoutMs, cwd } = {}) {
    const argv = [...prefixArgs, ...args, ...(dryRun ? ["--dry-run"] : [])];
    const label = `${command} ${argv[0] || ""}`.trim();

    return new Promise((resolve, reject) => {
      let child = null;
      try {
        // Some flags (im attachments) only accept cwd-relative paths, so the caller
        // gets to pin the working directory instead of inheriting the agent's.
        child = spawnImpl(command, argv, { env: targetEnv(), stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
      } catch (err) {
        reject(new ChannelError(ERROR_KINDS.PLATFORM, `cannot start ${label}: ${err.message}`, { cause: err }));
        return;
      }

      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        if (child) child.kill("SIGKILL");
      }, timeout);
      if (timer && typeof timer.unref === "function") timer.unref();

      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          if (child) child.kill("SIGKILL");
          return;
        }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new ChannelError(ERROR_KINDS.PLATFORM, `cannot start ${label}: ${err.message}`, { cause: err }));
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new ChannelError(ERROR_KINDS.RETRYABLE, `${label} timed out after ${timeout}ms`));
          return;
        }
        try {
          resolve(interpret(stdout, { label, code, signal, stderr }));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  return { run, command };
}

function interpret(stdout, { label, code, signal, stderr }) {
  if (code !== 0) {
    // lark-cli reports the failure twice: a non-zero exit *and* a structured
    // {ok:false,error} on stdout. Prefer the structured form -- dumping raw JSON
    // into an error message wastes the model's context and hides the code.
    // A transport failure can arrive as JSON on stderr with an empty stdout
    // (the CLI reports `{"type":"network","subtype":"timeout"}` on exit 4); if
    // only stdout is parsed, that diagnosis degrades into a raw text dump.
    const failed = parseJson(stdout) || parseJson(stderr);
    if (failed && failed.ok === false) {
      if (failed.error) throw toChannelError(failed.error, label);
      // Some commands fail softly: ok:false with result:"failed" and a warning
      // list that says why (str_replace refuses ambiguous patterns this way).
      // The warning is the entire diagnosis, so it must survive into the error.
      const warnings = (failed.data && failed.data.warnings) || [];
      if (failed.data && failed.data.result === "failed" && warnings.length) {
        throw new ChannelError(
          ERROR_KINDS.PLATFORM,
          `${label}: ${warnings.map((w) => String(w)).join("; ").slice(0, 300)}`,
          { status: code }
        );
      }
    }
    throw new ChannelError(
      ERROR_KINDS.PLATFORM,
      `${label} exited ${code}${signal ? ` (${signal})` : ""}: ${stderr.trim().slice(0, 300) || "no stderr"}`,
      { status: code }
    );
  }

  const payload = parseJson(stdout);
  if (!payload || typeof payload !== "object") {
    throw new ChannelError(
      ERROR_KINDS.PLATFORM,
      `${label} printed no JSON: ${(stdout || stderr).trim().slice(0, 300) || "empty output"}`
    );
  }
  if (payload.ok === false) throw toChannelError(payload.error || {}, label);
  return payload;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function toChannelError(error, label) {
  const status = Number(error.code);
  const subtype = String(error.subtype || "");
  const message = `${label}: ${subtype || error.type || "cli"} ${error.message || `(${error.code || "no code"})`}`;

  if (isAuthCode(status) || AUTH_SUBTYPE.test(subtype)) {
    return new ChannelError(ERROR_KINDS.AUTH, message, { status, code: error.code });
  }
  // Only HTTP-shaped codes may be read as HTTP. Feishu platform errors are
  // 6-7 digit numbers (e.g. 3380002 "unsupported document type"), and treating
  // any number >= 500 as "server error, retry" turns a permanent rejection into
  // a pointless retry loop.
  const httpish = Number.isFinite(status) && status >= 100 && status < 600;
  // `type:"network"` is the CLI's own label for a failed connection/timeout, and
  // it carries no HTTP-ish code at all, so it needs its own check.
  if (status === 429 || RETRY_SUBTYPE.test(subtype) || String(error.type || "") === "network" || (httpish && status >= 500)) {
    return new ChannelError(ERROR_KINDS.RETRYABLE, message, { status, code: error.code });
  }
  return new ChannelError(ERROR_KINDS.PLATFORM, message, { status, code: error.code });
}
