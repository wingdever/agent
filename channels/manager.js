"use strict";

// Channel lifecycle: build them, but never start them on their own.
//
// A proxy (a person's credential) is worth loading eagerly: it costs nothing until
// called. A channel is different -- starting it opens a long-lived connection and
// makes an external platform believe this machine is online. Auto-starting that at
// boot means every launch of the app, including a headless test run or a screenshot
// session, announces a bot to Feishu. So channels are built and validated at
// startup, then sit in `stopped` until someone explicitly asks.
//
// What "someone" means here: the entry layer passes a sink (how to run a turn), and
// the model can call the channels tool. There is no config switch to auto-start --
// the absence of that switch is the design, not an oversight.

import { createInboundPipeline } from "./inbound/pipeline.js";
import { createDedupe } from "./inbound/dedupe.js";

const STATUS = Object.freeze(["stopped", "starting", "running", "stopping", "error"]);

/**
 * @param {Object} options
 * @param {Object[]} options.channels built instances (see registry.js)
 * @param {{runTurn: Function}|null} [options.sink]
 * @param {() => number} [options.now]
 * @param {Function} [options.log]
 * @param {Function} [options.dedupeFactory]
 * @param {(message: Object) => void} [options.publish] called for accepted inbound messages
 */
export function createChannelManager({
  channels = [],
  sink = null,
  now = Date.now,
  log = () => {},
  dedupeFactory = () => createDedupe(),
  publish = null,
} = {}) {
  /** @type {Map<string, Object>} */
  const entries = new Map();
  /** @type {Set<Function>} */
  const subscribers = new Set();

  for (const channel of channels) {
    if (!channel || typeof channel !== "object") throw new TypeError("channel manager: channel must be an object");
    if (!channel.instanceId) throw new TypeError("channel manager: every channel needs an instanceId");
    const id = String(channel.instanceId);
    if (entries.has(id)) throw new TypeError(`channel manager: duplicate instance "${id}"`);
    entries.set(id, {
      id,
      channel,
      status: "stopped",
      error: null,
      startedAt: 0,
      startedBy: null,
      deliveries: 0,
      turns: 0,
      interactions: 0,
      interactionDedupe: dedupeFactory(),
      pipeline: null,
      pending: null,
      stopRequested: false,
    });
  }

  let currentSink = sink;

  function requireEntry(id) {
    const entry = entries.get(String(id));
    if (!entry) {
      const known = [...entries.keys()];
      throw new Error(`unknown channel "${id}" (known: ${known.join(", ") || "none"})`);
    }
    return entry;
  }

  function snapshot(entry) {
    const caps = entry.channel.capabilities || {};
    return {
      instanceId: entry.id,
      type: entry.channel.type,
      status: entry.status,
      error: entry.error,
      startedAt: entry.startedAt,
      startedBy: entry.startedBy,
      deliveries: entry.deliveries,
      turns: entry.turns,
      interactions: entry.interactions,
      eventMode: caps.eventMode,
      streaming: caps.streaming === true,
    };
  }

  function list() {
    return [...entries.values()].map(snapshot);
  }

  function emit() {
    const current = list();
    for (const listener of subscribers) {
      try { listener(current); } catch (_) { /* a dead listener must not block status changes */ }
    }
  }

  // A new subscriber gets the current roster immediately, then one full roster
  // snapshot on every status change. The initial send happens after registration
  // so no change between the two can be missed.
  function subscribe(listener) {
    subscribers.add(listener);
    listener(list());
    return () => subscribers.delete(listener);
  }

  function status(id) {
    return snapshot(requireEntry(id));
  }

  function has(id) {
    return entries.has(String(id));
  }

  /** The entry layer hands over how to run a turn; without it a start is meaningless. */
  function setSink(next) {
    if (!next || typeof next.runTurn !== "function") throw new TypeError("channel sink needs a runTurn function");
    if (next.interact !== undefined && typeof next.interact !== "function") {
      throw new TypeError("channel sink interact must be a function when provided");
    }
    currentSink = next;
  }

  /**
   * A button callback is not a message: it must never enter the turn queue.
   * The driver has already acknowledged the platform; this only routes the
   * decision back into the pending interaction.
   */
  function routeInteraction(entry, interaction) {
    const eventId = interaction && (interaction.eventId || interaction.interactionId);
    if (!eventId) {
      log(`[channel:${entry.id}] dropped interaction without an id`);
      return;
    }
    if (entry.interactionDedupe && !entry.interactionDedupe.claim(`interaction:${eventId}`)) {
      log(`[channel:${entry.id}] dropped duplicate interaction ${eventId}`);
      return;
    }
    entry.interactions++;
    if (!currentSink || typeof currentSink.interact !== "function") {
      log(`[channel:${entry.id}] no interaction sink; dropped ${eventId}`);
      return;
    }
    Promise.resolve()
      .then(() => currentSink.interact(interaction))
      .catch((err) => {
        log(`[channel:${entry.id}] interaction ${eventId} failed: ${(err && err.stack) || err}`);
      });
  }

  function ensurePipeline(entry) {
    if (entry.pipeline) return entry.pipeline;
    // A sink is optional now: a standalone channel service only needs the
    // pipeline for dedupe + publish, with no agent turn to run.
    entry.pipeline = createInboundPipeline({
      runTurn: (message, emit) => {
        if (!currentSink) return Promise.resolve();
        entry.turns++;
        return currentSink.runTurn(message, emit, { channel: entry.channel });
      },
      project: (message, event) => entry.channel.project(message, event),
      dedupe: dedupeFactory(),
      onError: (err, message) => {
        log(`[channel:${entry.id}] ${message ? message.eventId + " " : ""}${(err && err.stack) || err}`);
      },
    });
    return entry.pipeline;
  }

  async function start(id, { by = "user" } = {}) {
    const entry = requireEntry(id);
    // Starting twice must not open a second connection: the platform would treat
    // that as a duplicate bot session, and the old one would keep delivering.
    if (entry.status === "running") return snapshot(entry);
    if (entry.pending) return entry.pending;

    entry.status = "starting";
    entry.error = null;
    entry.stopRequested = false;
    emit();

    const pending = (async () => {
      try {
        // Credentials are a start-time concern, not a boot-time one: an instance may
        // be configured today and get its secret tomorrow. The driver declares what
        // is missing; refusing here means no connection attempt and no half state.
        const problems = typeof entry.channel.check === "function" ? entry.channel.check() : [];
        if (problems.length) {
          const refused = new Error(problems.join("; "));
          refused.name = "ChannelPreflightError";
          throw refused;
        }
        const pipeline = ensurePipeline(entry);
        await entry.channel.start(
          (message) => {
            entry.deliveries++;
            // The pipeline acks synchronously by contract; a rejection here would
            // mean an event was dropped after the platform already believed it landed.
            const result = pipeline.handle(message);
            if (result && result.accepted === false) {
              log(`[channel:${entry.id}] dropped event ${message.eventId || "?"}: ${result.reason || "refused"}`);
            } else if (typeof publish === "function") {
              // Only accepted (non-duplicate) messages reach subscribers. A
              // platform redelivery is deduped by the pipeline and never published.
              // publish may be async (history write); don't await it here — the
              // driver's ack must not wait on storage.
              Promise.resolve()
                .then(() => publish(message))
                .catch((err) => log(`[channel:${entry.id}] publish failed: ${(err && err.message) || err}`));
            }
          },
          (interaction) => routeInteraction(entry, interaction),
        );
        if (entry.stopRequested) {
          await entry.channel.stop();
          entry.status = "stopped";
          emit();
          return snapshot(entry);
        }
        entry.status = "running";
        entry.startedAt = now();
        entry.startedBy = by;
        emit();
        return snapshot(entry);
      } catch (err) {
        const reason = (err && err.message) || String(err);
        entry.status = "error";
        entry.error = reason;
        emit();
        // A preflight refusal is not a connection failure: say what is missing,
        // without claiming that connecting was attempted.
        if (err && err.name === "ChannelPreflightError") {
          throw new Error(`channel "${entry.id}" cannot start: ${reason}`);
        }
        throw new Error(`channel "${entry.id}" failed to start: ${reason}`);
      }
    })();

    entry.pending = pending;
    // Clearing must happen *after* the assignment: a preflight refusal rejects
    // synchronously, so a `finally` inside the async body would clear the slot
    // before it was ever set and leave a permanently rejected pending promise.
    pending
      .catch(() => {})
      .then(() => {
        if (entry.pending === pending) entry.pending = null;
      });
    return pending;
  }

  async function stop(id) {
    const entry = requireEntry(id);
    if (entry.pending) {
      // A stop that arrives mid-start must land after the connection exists,
      // otherwise the driver would finish starting and leave it open.
      entry.stopRequested = true;
      await entry.pending.catch(() => {});
    }
    if (entry.status === "stopped") return snapshot(entry);
    entry.status = "stopping";
    emit();
    try {
      await entry.channel.stop();
      entry.status = "stopped";
      entry.error = null;
      entry.pipeline = null; // a restart begins with an empty dedupe window
      entry.interactionDedupe = dedupeFactory();
      entry.startedAt = 0;
      entry.startedBy = null;
      emit();
      return snapshot(entry);
    } catch (err) {
      entry.status = "error";
      entry.error = (err && err.message) || String(err);
      emit();
      throw new Error(`channel "${entry.id}" failed to stop: ${entry.error}`);
    }
  }

  async function stopAll() {
    const running = [...entries.values()].filter((entry) => entry.status !== "stopped");
    for (const entry of running) {
      try {
        await stop(entry.id);
      } catch (err) {
        log(`[channel:${entry.id}] stop failed: ${(err && err.message) || err}`);
      }
    }
  }

  return { list, status, has, start, stop, stopAll, setSink, subscribe, emit, STATUS };
}
