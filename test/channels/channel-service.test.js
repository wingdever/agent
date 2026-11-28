"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createChannel as createFakeChannel } from "../../channels/fake/index.js";
import { startChannelService } from "../../lib/channel-service/runtime.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("generic channel service owns history, lock, auth and ACK", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-service-"));
  const id = "fake-service";
  const fake = createFakeChannel({ instance: { id } });
  const service = await startChannelService({
    instanceId: id,
    channels: [fake],
    token: "verify-token",
    historyFile: path.join(dir, "history.db"),
    archiveDir: path.join(dir, "archive"),
    dedupeFile: path.join(dir, "dedupe.json"),
    archiveIntervalMs: 0,
    log: () => {},
  });
  try {
    const health = await fetch(service.address.healthUrl);
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).features, ["messages", "proactive", "auth"]);

    const message = {
      eventId: "svc-1", type: "fake", instanceId: id, conversationKey: "C1",
      messages: [{ role: "user", content: "hello" }],
    };
    await fake.inject(message);
    await sleep(20);
    assert.deepEqual((await service.history.getPending(id)).map((m) => m.eventId), ["svc-1"]);

    const ack = await fetch(service.address.sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer verify-token" },
      body: JSON.stringify({ instanceId: id, conversationKey: "C1", text: "", status: "ack", ackEventId: "svc-1" }),
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(await service.history.getPending(id), []);
  } finally {
    await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(path.join(dir, "history.db")), false, "temp dir removed after stop");
});

test("a second service for the same instance is refused by the shared lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-service-"));
  const id = "fake-locked";
  const first = await startChannelService({
    instanceId: id,
    channels: [createFakeChannel({ instance: { id } })],
    token: "verify-token",
    historyFile: path.join(dir, "first.db"),
    archiveIntervalMs: 0,
    log: () => {},
  });
  try {
    await assert.rejects(() => startChannelService({
      instanceId: id,
      channels: [createFakeChannel({ instance: { id } })],
      token: "verify-token",
      historyFile: path.join(dir, "second.db"),
      archiveIntervalMs: 0,
      log: () => {},
    }), /already running/);
  } finally {
    await first.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
