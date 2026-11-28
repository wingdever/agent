"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireChannelLock, releaseChannelLock } from "../../lib/channel-lock.js";

test("the lock is atomic, private and released only by its owner process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-lock-"));
  try {
    const first = acquireChannelLock("qq-bot", { dir });
    assert.equal(first.ok, true);
    const mode = fs.statSync(first.file).mode & 0o777;
    assert.equal(mode, 0o600);
    const second = acquireChannelLock("qq-bot", { dir });
    assert.equal(second.ok, false);
    assert.equal(second.pid, process.pid);
    releaseChannelLock(first.file);
    assert.equal(fs.existsSync(first.file), false);
    assert.equal(acquireChannelLock("qq-bot", { dir }).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead holder's lock can be taken over", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-lock-"));
  try {
    const file = path.join(dir, "run-stale.lock");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, at: new Date().toISOString() }), { mode: 0o600 });
    const lock = acquireChannelLock("stale", { dir });
    assert.equal(lock.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(lock.file, "utf8")).pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
