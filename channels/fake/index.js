"use strict";

// Fake platform driver.
//
// Its job is to be a *constrained* stand-in for a real platform, so the shared
// layer can be tested without credentials: it has an ack deadline, a message
// size cap, an outbound rate limit, and switchable faults (auth rejection, duplicate
// delivery, oversized text). The extra methods below (inject/send/failNextAuth)
// are test affordances and not part of the channel contract.

import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";
import { createOutboundQueue } from "./../../accounts/outbound/queue.js";
import { segmentText } from "./../../accounts/outbound/segment.js";

export const type = "fake";

export function createChannel({ instance = {} } = {}) {
  const capabilities = Object.freeze({
    eventMode: "ws",
    ackDeadlineMs: 3000,
    maxTextBytes: 200,
    outboundQps: 5,
    streaming: true,
    canPromptUser: false,
    canAttachFiles: false,
  });

  const state = {
    handler: null,
    started: false,
    projections: [],
    sends: [],
    invalidations: 0,
    pendingAuthFailures: 0,
  };

  const auth = {
    async headers() {
      if (state.pendingAuthFailures > 0) {
        state.pendingAuthFailures--;
        throw new ChannelError(ERROR_KINDS.AUTH, "fake: access token expired", { status: 401, code: 99991663 });
      }
      return { "x-fake-token": "ok" };
    },
    async invalidate() {
      state.invalidations++;
    },
  };

  const outbound = createOutboundQueue({ qps: capabilities.outboundQps, auth });

  const channel = {
    type,
    instanceId: instance.id || "fake-1",
    capabilities,
    auth,

    async start(onMessage) {
      if (typeof onMessage !== "function") throw new TypeError("start requires an onMessage handler");
      state.handler = onMessage;
      state.started = true;
    },

    async project(message, event) {
      state.projections.push({ sessionId: message.sessionId, event });
    },

    async stop() {
      state.handler = null;
      state.started = false;
    },

    // --- test affordances -------------------------------------------------
    /** Deliver one inbound message and return how long the ack took. */
    async inject(message) {
      if (!state.handler) throw new Error("fake channel is not started");
      const startedAt = Date.now();
      await state.handler(message);
      return Date.now() - startedAt;
    },

    /** Send text through the paced queue, segmenting at the platform cap. */
    async send(text) {
      const segments = segmentText(text, capabilities.maxTextBytes);
      const results = [];
      for (const segment of segments) {
        results.push(
          await outbound.push(async () => {
            await auth.headers();
            state.sends.push(segment);
          })
        );
      }
      return results;
    },

    /** Make the next credential use fail with an auth error. */
    failNextAuth() {
      state.pendingAuthFailures++;
    },

    get projections() {
      return state.projections;
    },
    get sends() {
      return state.sends;
    },
    get invalidations() {
      return state.invalidations;
    },
    get started() {
      return state.started;
    },
  };

  return channel;
}
