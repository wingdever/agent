"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("commit mode does not persist an unfinished claim", () => {
  const file = "/tmp/channel-dedupe-commit-test.json";
  try { fs.unlinkSync(file); } catch (_) {}
  const first = createDedupe({ capacity: 4, file, persistOn: "commit" });
  assert.equal(first.claim("inflight"), true);
  assert.equal(first.isPending("inflight"), true);
  // A restart loses the in-memory claim, so the event can be replayed.
  const second = createDedupe({ capacity: 4, file, persistOn: "commit" });
  assert.equal(second.claim("inflight"), true);
  second.commit("inflight");
  const third = createDedupe({ capacity: 4, file, persistOn: "commit" });
  assert.equal(third.claim("inflight"), false, "a committed event stays deduped");
});

test("release lets a failed claim be retried", () => {
  const dedupe = createDedupe({ capacity: 4, persistOn: "commit" });
  assert.equal(dedupe.claim("retry-me"), true);
  assert.equal(dedupe.claim("retry-me"), false);
  dedupe.release("retry-me");
  assert.equal(dedupe.claim("retry-me"), true);
});

test("persist writes an atomic rename and leaves no temp file", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dedupe-atomic-"));
  const file = path.join(dir, "state.json");
  try {
    const dedupe = createDedupe({ capacity: 4, file });
    dedupe.claim("atomic-1");
    dedupe.claim("atomic-2");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(state.version, 1);
    assert.equal(state.entries.length, 2);
    // The temp artifact must be gone after a successful rename.
    await assert.rejects(() => fs.access(file + ".tmp"), /ENOENT/);
    // A fresh instance reads the complete file, not a truncated one.
    const reopened = createDedupe({ capacity: 4, file });
    assert.equal(reopened.claim("atomic-1"), false);
    assert.equal(reopened.claim("atomic-2"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
