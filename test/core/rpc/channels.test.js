"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcRegistry } from "../../../core/rpc/registry.js";
import defineChannelCommands from "../../../core/rpc/handlers/channels.js";
import { createChannelManager } from "../../../channels/manager.js";
import { createChannel as createFakeChannel } from "../../../channels/fake/index.js";

function makeCore() {
  const manager = createChannelManager({
    channels: [createFakeChannel({ instance: { id: "bot" } })],
    sink: { async runTurn() {} },
  });
  return { core: { capabilities: { channels: manager } }, manager };
}

test("channel RPC lists, starts and stops an instance", async () => {
  const { core } = makeCore();
  const rpc = new RpcRegistry(core);
  defineChannelCommands(rpc);

  const listed = await rpc.handle("channel.list", {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].instanceId, "bot");
  assert.equal(listed[0].status, "stopped");

  const started = await rpc.handle("channel.start", { id: "bot" });
  assert.equal(started.status, "running");
  assert.equal(started.startedBy, "user");

  const stopped = await rpc.handle("channel.stop", { id: "bot" });
  assert.equal(stopped.status, "stopped");
});

test("channel.subscribe pushes an initial roster and releases on cancel", async () => {
  const { core, manager } = makeCore();
  const rpc = new RpcRegistry(core);
  defineChannelCommands(rpc);

  const events = [];
  let cancel = null;
  const pending = rpc.handle("channel.subscribe", {}, {
    onEvent: (evt) => events.push(evt),
    onCancel: (fn) => { cancel = fn; },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "snapshot");
  assert.equal(events[0].channels[0].status, "stopped");

  await manager.start("bot");
  assert.equal(events[events.length - 1].channels[0].status, "running");

  const before = events.length;
  assert.equal(typeof cancel, "function");
  cancel();
  await pending;
  await manager.start("bot");
  assert.equal(events.length, before);
});
