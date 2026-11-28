"use strict";

// Event idempotency for inbound channel traffic.
//
// Platforms re-deliver events (no ack, retry after timeout, connection flap). A
// re-delivered event that re-runs a turn doubles token spend and doubles the
// rows written, so intake must be able to answer "have I already claimed this?".
//
// This state belongs to the channel, not to core: core has no notion of platform
// event ids, and adding one would leak transport concerns into storage.

import fs from "fs";
import path from "path";

/**
 * @param {{capacity?: number, ttlMs?: number, now?: () => number, file?: string|null,
 *          persistOn?: "claim"|"commit"}} [options]
 *
 * persistOn:
 *   "claim"  — the default. A claim is durable immediately (channel intake:
 *              duplicate platform deliveries must never reach history twice).
 *   "commit" — a claim is only durable after commit(). Used by the core-side
 *              listener: a process that dies mid-turn must replay the event,
 *              not suppress it as a duplicate.
 */
export function createDedupe({
  capacity = 2000,
  ttlMs = 24 * 60 * 60 * 1000,
  now = Date.now,
  file = null,
  persistOn = "claim",
} = {}) {
  if (persistOn !== "claim" && persistOn !== "commit") {
    throw new TypeError(`dedupe persistOn must be "claim" or "commit"`);
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Set<string>} claims that are not durable yet (commit mode). */
  const pending = new Set();
  const stats = { claimed: 0, duplicates: 0, evicted: 0 };

  if (file) load();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, at] of seen) {
      if (at <= cutoff) {
        seen.delete(id);
        stats.evicted++;
      } else {
        break; // insertion order == arrival order, so the tail is all fresh
      }
    }
    while (seen.size > capacity) {
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
      stats.evicted++;
    }
  }

  /**
   * Claim an event id. Returns true exactly once per id (within capacity/ttl).
   * In commit mode this only reserves the id in memory; call commit() after
   * the work succeeds.
   * @param {string} eventId
   * @returns {boolean}
   */
  function claim(eventId) {
    const id = String(eventId || "");
    if (!id) throw new TypeError("claim requires a non-empty eventId");
    prune();
    if (seen.has(id) || pending.has(id)) {
      stats.duplicates++;
      return false;
    }
    stats.claimed++;
    if (persistOn === "claim") {
      seen.set(id, now());
      // Prune after insert: checking only before the insert lets size exceed the
      // capacity by exactly one on every claim.
      prune();
      if (file) persist();
    } else {
      pending.add(id);
    }
    return true;
  }

  /** Make a commit-mode claim durable. No-op after a claim-mode claim. */
  function commit(eventId) {
    const id = String(eventId || "");
    if (!id) return false;
    pending.delete(id);
    if (persistOn === "commit") {
      seen.set(id, now());
      prune();
      if (file) persist();
    }
    return true;
  }

  /** Drop a claim that did not complete, so a replay can run it again. */
  function release(eventId) {
    const id = String(eventId || "");
    if (!id) return false;
    pending.delete(id);
    if (persistOn === "claim" && seen.delete(id) && file) persist();
    return true;
  }

  function isPending(eventId) {
    return pending.has(String(eventId || ""));
  }

  function has(eventId) {
    const id = String(eventId || "");
    return seen.has(id) || pending.has(id);
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [id, at] of parsed.entries || []) {
        if (Number.isFinite(at)) seen.set(id, at);
      }
      prune();
    } catch (_) {
      // missing or corrupt state is not fatal: a fresh file re-claims events
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Write to a sibling temp file then rename: a crash mid-write leaves
      // either the old complete file or the new one, never a truncated file
      // that load() would silently treat as an empty dedupe window.
      const temp = file + ".tmp";
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: [...seen] }));
      fs.renameSync(temp, file);
    } catch (_) {
      // persistence is best effort; in-memory dedupe still holds for this run.
      // A leftover .tmp is harmless — the next persist overwrites it.
    }
  }

  return {
    claim,
    commit,
    release,
    isPending,
    has,
    stats,
    size: () => seen.size + pending.size,
    _seen: seen,
  };
}
