"use strict";

// Inbound pipeline: event -> dedupe -> per-session serial queue -> turn -> projection.
//
// The one rule that shapes everything here: handle() must return immediately.
// Feishu requires the callback to be answered within 3s while a single turn
// measures around a minute. Waiting for the turn inside the handler means every
// message is re-delivered, and every re-delivery runs the turn again.

import { classifyError } from "./../../accounts/errors.js";
import { sessionIdFor } from "./../session-namespace.js";

/**
 * @param {Object} options
 * @param {(message: Object, emit: (event: Object) => void) => Promise<void>} options.runTurn
 * @param {(message: Object, event: Object) => Promise<void>} options.project
 * @param {(message: Object) => Promise<void>} [options.beforeRun] durable write / publish hook before a turn
 * @param {ReturnType<typeof import("./dedupe.js").createDedupe>} [options.dedupe]
 * @param {number} [options.maxInFlightPerSession] must stay 1: platform retries make concurrent turns on one conversation self-defeating
 * @param {(err: unknown, message: Object) => void} [options.onError]
 */
export function createInboundPipeline({
  runTurn,
  project,
  beforeRun = null,
  dedupe = null,
  maxInFlightPerSession = 1,
  onError = null,
} = {}) {
  if (typeof runTurn !== "function") throw new TypeError("runTurn must be a function");
  if (typeof project !== "function") throw new TypeError("project must be a function");

  /** @type {Map<string, {items: Object[], active: number, drain: Promise<void>|null}>} */
  const sessions = new Map();
  const stats = { accepted: 0, duplicates: 0, turns: 0, failures: 0 };
  const waiters = [];

  function sessionState(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { items: [], active: 0, drain: null };
      sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Accept one inbound message. Synchronous by design: the caller (driver) acks
   * the platform as soon as this returns.
   * @param {Object} message
   * @returns {{accepted: boolean, reason?: string, sessionId?: string}}
   */
  function handle(message) {
    if (!message || typeof message !== "object") throw new TypeError("handle requires a message object");
    if (!message.eventId) throw new TypeError("inbound message requires eventId");
    if (!message.conversationKey) throw new TypeError("inbound message requires conversationKey");

    if (dedupe && !dedupe.claim(message.eventId)) {
      stats.duplicates++;
      return { accepted: false, reason: "duplicate" };
    }

    const sessionId = message.sessionId || sessionIdFor(message);
    const state = sessionState(sessionId);
    state.items.push({ ...message, sessionId });
    stats.accepted++;
    schedule(sessionId, state);
    return { accepted: true, sessionId };
  }

  function schedule(sessionId, state) {
    if (state.drain) return;
    state.drain = Promise.resolve()
      .then(() => pump(sessionId, state))
      .catch((err) => {
        stats.failures++;
        if (onError) onError(err, null);
      })
      .finally(() => {
        state.drain = null;
        maybeResolve();
      });
  }

  async function pump(sessionId, state) {
    while (state.items.length && state.active < maxInFlightPerSession) {
      const message = state.items.shift();
      state.active++;
      try {
        await runOne(message);
      } finally {
        state.active--;
      }
    }
  }

  async function runOne(message) {
    // Projection runs live, not after the turn: an approval card must reach the
    // user while the turn is suspended waiting for the click. A serial queue
    // preserves event order for projectors that patch one message in place.
    let projection = Promise.resolve();
    const projectEvent = (event) => {
      projection = projection
        .then(() => project(message, event))
        .catch((err) => {
          stats.failures++;
          if (onError) onError(err, message);
        });
    };
    const emit = (event) => projectEvent(event);

    try {
      stats.turns++;
      // Persist (and publish) before the turn starts. The platform ack already
      // happened at intake, but this closes the "event accepted, history not
      // written" window that a fire-and-forget publish left open.
      if (typeof beforeRun === "function") await beforeRun(message);
      await runTurn(message, emit);
    } catch (err) {
      const kind = classifyError(err);
      stats.failures++;
      if (onError) onError(err, message);
      // A failed turn still projects its terminal error event: silence would
      // leave the user staring at "typing..." forever.
      projectEvent({ type: "error", kind, message: String((err && err.message) || err) });
    }
    await projection;
  }

  function maybeResolve() {
    let busy = false;
    for (const state of sessions.values()) {
      if (state.drain || state.items.length || state.active) {
        busy = true;
        break;
      }
    }
    if (!busy) {
      sessions.clear();
      while (waiters.length) waiters.shift()();
    }
  }

  /** Resolve when every accepted message has finished projecting. */
  function idle() {
    let busy = false;
    for (const state of sessions.values()) {
      if (state.drain || state.items.length || state.active) {
        busy = true;
        break;
      }
    }
    if (!busy) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  return { handle, idle, stats };
}
