"use strict";

// Fake human-account proxy.
//
// Stands in for a real person's grant so the slot can be exercised without an
// OAuth consent flow: it answers whoami, enforces scopes, and can reject a call
// for missing scope or a dead credential. Actions are symbolic, not real API paths.

import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";
import { createOutboundQueue } from "./../../accounts/outbound/queue.js";

export const type = "fake";

const OPS = {
  "doc.read": { scope: "doc:read", run: async (params) => ({ path: params.path, content: "# fake document" }) },
  "doc.write": { scope: "doc:write", run: async (params) => ({ path: params.path, written: true }) },
  "drive.list": { scope: "drive:read", run: async () => ({ items: [] }) },
};

export const KNOWN_ACTIONS = Object.keys(OPS);

export function createProxy({ instance = {} } = {}) {
  const scopes = Array.isArray(instance.scopes) ? instance.scopes : ["doc:read"];
  const state = {
    who: instance.who || "fake-human",
    calls: [],
    invalidations: 0,
    pendingAuthFailures: 0,
  };

  const auth = {
    async headers() {
      if (state.pendingAuthFailures > 0) {
        state.pendingAuthFailures--;
        throw new ChannelError(ERROR_KINDS.AUTH, "fake: user token expired", { status: 401, code: 99991668 });
      }
      return { "x-fake-user-token": "ok" };
    },
    async invalidate() {
      state.invalidations++;
    },
  };

  const outbound = createOutboundQueue({ qps: instance.qps || 5, auth });

  const proxy = {
    type,
    instanceId: instance.id || "fake-proxy",
    scopes,
    auth,

    async whoami() {
      return state.who;
    },

    async call(action, params = {}) {
      const op = OPS[action];
      if (!op) throw new ChannelError(ERROR_KINDS.PLATFORM, `fake: unknown action "${action}"`, {});
      if (!scopes.includes(op.scope)) {
        throw new ChannelError(ERROR_KINDS.PLATFORM, `fake: scope "${op.scope}" is not granted`, {});
      }
      return outbound.push(async () => {
        await auth.headers();
        state.calls.push({ action, params });
        return op.run(params);
      });
    },

    // --- test affordances -------------------------------------------------
    failNextAuth() {
      state.pendingAuthFailures++;
    },
    get calls() {
      return state.calls;
    },
    get invalidations() {
      return state.invalidations;
    },
  };

  return proxy;
}
