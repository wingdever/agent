"use strict";

// lark proxy, "cli" implementation.
//
// The credential is not ours to hold: it lives in the already-logged-in lark-cli
// session (env token or the CLI's own profile). So auth.headers() returns nothing
// and invalidate() cannot refresh anything -- if the human's token is dead, the
// CLI must be logged in again. That limitation is exactly why the oauth route
// exists; both routes expose the same contract, so switching is config-only.
//
// Gate order matters: reject on scope or risk BEFORE spawning a process, so a
// refused action has no side effect at all.

import fs from "fs";
import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";
import { createOutboundQueue } from "./../../accounts/outbound/queue.js";
import { createCliRunner } from "./runner.js";
import { resolveAction } from "./gate.js";

export function createCliProxy({ instance = {}, deps = {} } = {}) {
  const options = instance.options || {};
  const scopes = Array.isArray(instance.scopes)
    ? instance.scopes
    : ["docx:document:readonly", "drive:drive:readonly"];

  const runner =
    deps.runner ||
    createCliRunner({
      command: options.command || "lark-cli",
      prefixArgs: options.prefixArgs || [],
      timeoutMs: options.timeoutMs,
      env: deps.env || instance.env || null,
      spawnImpl: deps.spawn,
    });

  // One CLI process per call, so pacing is about the person's API quota and the
  // machine's load, not about a socket. Auth is deliberately not wired in: the
  // queue's "refresh and retry once" path cannot help a CLI session.
  const outbound = createOutboundQueue({ qps: options.qps || 1, maxAttempts: 2, auth: null });

  const auth = {
    async headers() {
      return {};
    },
    async invalidate() {
      // Nothing to drop: the CLI owns the session.
    },
  };

  let identity = null;

  /** A human proxy acting as a bot would be a lie about who is doing the work. */
  function expectUserSession(payload, what) {
    if (payload.identity && payload.identity !== "user") {
      throw new ChannelError(
        ERROR_KINDS.PLATFORM,
        `lark: ${what} is running as "${payload.identity}", but this proxy requires a human (user) session`
      );
    }
    return payload;
  }

  async function whoami() {
    if (identity === null) {
      identity = await outbound.push(async () => {
        const payload = expectUserSession(await runner.run(["api", "GET", "/open-apis/authen/v1/user_info"]), "whoami");
        const data = payload.data || {};
        const name = data.name || data.en_name;
        if (!name) throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: user_info returned no name");
        return String(name);
      });
    }
    return identity;
  }

  async function call(action, params = {}) {
    const { spec } = resolveAction({ action, params, scopes, options });

    // Some actions are one verb over N items (deleting five files is five
    // processes, not one). `expand` says so; the loop below is the only place
    // that knows how to fan out, so specs stay single-item.
    const steps = spec.expand ? spec.expand(params) : [params];
    const done = [];
    const failed = [];

    for (const step of steps) {
      const stepParams = steps.length === 1 ? params : { ...params, files: [step] };
      try {
        // Actions that need more than one step (download then seek, poll a task)
        // own their execution; everything else stays a pure argv mapping.
        if (spec.run) {
          const out = await spec.run({
            params: stepParams,
            fs,
            cli: (argv, opts) =>
              outbound.push(async () => {
                const payload = expectUserSession(await runner.run(argv, opts), action);
                return payload.data ?? {};
              }),
          });
          done.push(out);
          continue;
        }
        const argv = spec.args(stepParams);
        const shaped = await outbound.push(async () => {
          const payload = expectUserSession(await runner.run(argv), action);
          const data = payload.data ?? {};
          // Same normalization as the oauth route: an action's shape() is about
          // the platform's answer, not about which transport fetched it.
          const out = spec.shape ? spec.shape(data, stepParams) : data;
          return spec.post ? spec.post(out, stepParams) : out;
        });
        done.push(shaped);
      } catch (err) {
        if (steps.length === 1) throw err;
        failed.push({ token: step.token, type: step.type, error: err.message });
      }
    }

    if (steps.length === 1) return done[0];
    return { deleted: done, failed, attempted: steps.length };
  }

  return {
    type: "lark",
    instanceId: instance.id || "lark",
    scopes,
    auth,
    whoami,
    call,

    // --- test affordances -------------------------------------------------
    get runner() {
      return runner;
    },
  };
}
