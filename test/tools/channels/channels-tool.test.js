"use strict";

import test from "node:test";
import assert from "assert/strict";

import { run } from "../../../tools/channels/run.js";
import { createCapabilities } from "../../../core/capabilities.js";
import { createChannelManager } from "../../../channels/manager.js";
import { createChannel as createFakeChannel } from "../../../channels/fake/index.js";

function setup(ids = ["bot"]) {
  const channels = ids.map((id) => createFakeChannel({ instance: { id } }));
  const manager = createChannelManager({ channels });
  manager.setSink({ async runTurn() {} });
  return { manager, exec: { capabilities: createCapabilities({ channels: manager }) }, channels };
}

test("list reports every configured channel with its status", async () => {
  const { exec } = setup(["a", "b"]);
  const result = await run({ action: "list" }, exec);
  const parsed = JSON.parse(result.text);
  assert.deepEqual(parsed.map((entry) => entry.instanceId), ["a", "b"]);
  assert.deepEqual(parsed.map((entry) => entry.status), ["stopped", "stopped"]);
});

test("start opens the single configured channel and reports running", async () => {
  const { exec, channels } = setup(["bot"]);
  const result = await run({ action: "start" }, exec);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.status, "running");
  assert.equal(parsed.startedBy, "model");
  assert.equal(channels[0].started, true);
  assert.deepEqual(result.meta, { channel: "bot", action: "start" });
});

test("with several channels the id is required", async () => {
  const { exec } = setup(["a", "b"]);
  await assert.rejects(run({ action: "start" }, exec), /several channels are configured \(a, b\); pass "channel" explicitly/);
});

test("status and stop act on the named channel only", async () => {
  const { exec, channels } = setup(["a", "b"]);
  await run({ action: "start", channel: "b" }, exec);
  assert.equal(JSON.parse((await run({ action: "status", channel: "b" }, exec)).text).status, "running");
  assert.equal(JSON.parse((await run({ action: "status", channel: "a" }, exec)).text).status, "stopped");

  const stopped = JSON.parse((await run({ action: "stop", channel: "b" }, exec)).text);
  assert.equal(stopped.status, "stopped");
  assert.equal(channels[1].started, false);
  assert.equal(channels[0].started, false);
});

test("an unknown channel id fails with the known ids", async () => {
  const { exec } = setup(["bot"]);
  await assert.rejects(run({ action: "status", channel: "nope" }, exec), /unknown channel "nope" \(known: bot\)/);
});

test("without a channel capability the tool refuses instead of inventing one", async () => {
  const exec = { capabilities: createCapabilities() };
  await assert.rejects(run({ action: "list" }, exec), /channel control is unavailable/);
  await assert.rejects(run({ action: "start" }, exec), /channel control is unavailable/);
});

test("an unknown action is rejected before touching state", async () => {
  const { exec, channels } = setup(["bot"]);
  await assert.rejects(run({ action: "restart" }, exec), /unknown action "restart"/);
  assert.equal(channels[0].started, false);
});
