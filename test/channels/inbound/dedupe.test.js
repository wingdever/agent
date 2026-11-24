"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDedupe } from "../../../channels/inbound/dedupe.js";

test("an id is claimed only once", () => {
  const dedupe = createDedupe({ capacity: 4 });
  assert.equal(dedupe.claim("e1"), true);
  assert.equal(dedupe.claim("e1"), false);
  assert.equal(dedupe.stats.duplicates, 1);
});

test("capacity evicts the oldest id so memory stays bounded", () => {
  const dedupe = createDedupe({ capacity: 2 });
  ["e1", "e2", "e3"].forEach((id) => dedupe.claim(id));
  assert.equal(dedupe.size(), 2);
  // e1 was evicted, so it looks new again - acceptable for a bounded ring.
  assert.equal(dedupe.claim("e1"), true);
});

test("ttl expires ids so a long-lived process does not grow forever", () => {
  let t = 0;
  const dedupe = createDedupe({ capacity: 8, ttlMs: 1000, now: () => t });
  dedupe.claim("old");
  t = 2000;
  dedupe.claim("new");
  assert.equal(dedupe.size(), 1);
  assert.equal(dedupe.claim("old"), true);
});

test("state survives a restart through the state file", () => {
  const file = "/tmp/channel-dedupe-test.json";
  const first = createDedupe({ capacity: 4, file });
  first.claim("persisted");
  const second = createDedupe({ capacity: 4, file });
  assert.equal(second.claim("persisted"), false);
});
