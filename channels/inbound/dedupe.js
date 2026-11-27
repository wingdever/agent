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
 * @param {{capacity?: number, ttlMs?: number, now?: () => number, file?: string|null}} [options]
 */
export function createDedupe({ capacity = 2000, ttlMs = 24 * 60 * 60 * 1000, now = Date.now, file = null } = {}) {
  /** @type {Map<string, number>} */
  const seen = new Map();
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
   * @param {string} eventId
   * @returns {boolean}
   */
  function claim(eventId) {
    const id = String(eventId || "");
    if (!id) throw new TypeError("claim requires a non-empty eventId");
    prune();
    if (seen.has(id)) {
      stats.duplicates++;
      return false;
    }
    seen.set(id, now());
    stats.claimed++;
    // Prune after insert: checking only before the insert lets size exceed the
    // capacity by exactly one on every claim.
    prune();
    if (file) persist();
    return true;
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

  return { claim, stats, size: () => seen.size, _seen: seen };
}
