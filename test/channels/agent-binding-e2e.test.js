"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { createChannelCallback } from "../../channels/callback.js";
import { loadAgentProfile, chatOptions } from "../../lib/agent-profile/index.js";
import channelSendNode from "../../core/loops/nodes/channel-send/run.js";

const PROJECT_ROOT_ASSETS = path.join(__dirname, "..", "..", "assets");

// A minimal engine-like runner: apply the agent's hooks by calling the hooked
// node after model-call, mirroring node-graph's _wireHooks behaviour.
function runTurnWithAgentHooks(agentProfile, ctx) {
  const hooks = agentProfile.loops.filter((h) => h.on === "model-call" && h.slot === "after");
  return hooks.map((h) => h.target);
}

test("a channel bound to qq-bot loads an agent whose loops send replies", async () => {
  // Materialize the bot agent from assets into a temp agents dir, then load it
  // the same way profileFor does for a bound channel instance.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "binding-e2e-"));
  const agentsDir = path.join(dir, "agents");
  const assetsDir = path.join(PROJECT_ROOT_ASSETS, "agents");
  try {
    const profile = loadAgentProfile("qq-bot", { agentsDir, assetsDir });
    const targets = runTurnWithAgentHooks(profile, {});
    assert.ok(targets.includes("channel-send"), "qq-bot loops include channel-send on model-call.after");

    const options = chatOptions(profile);
    assert.equal(options.model, "spark-x2.6-4b");
    assert.ok(options.persona && options.persona.includes("QQ 群机器人"), "prompt used as persona");

    // Real callback service: the reply the agent's hook sends must reach QQ.
    const sent = [];
    const service = createChannelCallback({
      lookupChannel: () => ({ type: "qq", instanceId: "alice-qq", async project(m, e) { sent.push(e); } }),
      log: () => {},
    });
    const addr = await service.listen();
    try {
      const result = await channelSendNode({}, {
        channelDelivery: { endpoint: addr.url, instanceId: "alice-qq", conversationKey: "G1" },
        step: { response: { content: "绑定后的回复" } },
        emit: () => {},
        fetchImpl: globalThis.fetch,
      });
      assert.equal(result.next, "decide-next");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].content, "绑定后的回复");
    } finally {
      await service.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
