"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import nodeGraph from "../../core/loops/node-graph.js";
import { createChannelCallback } from "../../channels/callback.js";
import { loadAgentProfile } from "../../lib/agent-profile/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "..", "assets");

test("a turn with qq-bot's loops sends the model answer through /proactive", async () => {
  // Load the real agent orchestration from assets.
  const profile = loadAgentProfile("qq-bot", {
    agentsDir: path.join(__dirname, "tmp-agents-outbound"),
    assetsDir: path.join(ASSETS, "agents"),
  });
  const channelSendHook = profile.loops.find((h) => h.target === "channel-send");
  assert.ok(channelSendHook, "agent loops contain the channel-send hook");

  // Real callback service.
  const sent = [];
  const service = createChannelCallback({
    lookupChannel: () => ({ type: "qq", instanceId: "alice-qq", async project(m, e) { sent.push(e); } }),
    log: () => {},
  });
  const addr = await service.listen();

  try {
    // Real engine with the agent's hooks, driven through model-call only.
    const engine = new nodeGraph.NodeGraphEngine();
    engine._wireHooks(profile.loops);
    const ctx = {
      channelDelivery: { endpoint: addr.url, instanceId: "alice-qq", conversationKey: "G1" },
      step: { response: { content: "引擎里发出的回复" } },
      emit: () => {},
      fetchImpl: globalThis.fetch,
      translateCfg: { enabled: false }, // skip translate hook; we test channel-send
      services: {},
    };
    // Fire the after hooks the way _runNode does for model-call.
    for (const fn of engine.hooks["model-call"].after) {
      await fn(ctx.step.response, ctx);
    }
    assert.equal(sent.length, 1, "channel-send hook reached the QQ send");
    assert.equal(sent[0].content, "引擎里发出的回复");
  } finally {
    await service.close();
  }
});
