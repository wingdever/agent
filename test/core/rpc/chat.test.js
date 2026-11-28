"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcRegistry } from "../../../core/rpc/registry.js";
import defineChatCommands from "../../../core/rpc/handlers/chat.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-preset-"));
  const agentsDir = path.join(dir, "agents");
  const botDir = path.join(agentsDir, "curator");
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(botDir, "config.json"), JSON.stringify({
    name: "采集", identity: "You are a source curator.", persona: "Terse.", model: "preset-model", effort: "high",
  }));
  fs.writeFileSync(path.join(botDir, "prompt"), "Collect sources.");
  fs.writeFileSync(path.join(botDir, "tools.json"), JSON.stringify(["read", "web_fetch"]));
  const hooks = [{ on: "model-call", slot: "after", target: "channel-send" }];
  fs.writeFileSync(path.join(botDir, "loops.json"), JSON.stringify(hooks));
  let captured = null;
  const rpc = new RpcRegistry({
    agent: { chat: async (ctx) => { captured = ctx; return { ok: true }; } },
  });
  defineChatCommands(rpc, { agentsDir });
  return { dir, rpc, hooks, ctx: () => captured };
}

test("chat.send resolves a preset on the server and overrides caller toolNames", async () => {
  const fx = fixture();
  try {
    await fx.rpc.handle("chat.send", {
      messages: [{ role: "user", content: "go" }],
      agentId: "curator",
      toolNames: ["bash"],
      effort: "low",
    });
    const ctx = fx.ctx();
    assert.equal(ctx.identity, "You are a source curator.");
    assert.equal(ctx.persona, "Terse.\n\nCollect sources.");
    assert.deepEqual(ctx.toolNames, ["read", "web_fetch"], "preset allowlist wins");
    assert.deepEqual(ctx.loops, fx.hooks);
    assert.equal(ctx.model, "preset-model", "preset model used when caller omits one");
    assert.equal(ctx.effort, "low", "caller effort still wins");
    assert.equal(ctx.messages.length, 1);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("chat.send without agentId leaves caller params untouched", async () => {
  const fx = fixture();
  try {
    await fx.rpc.handle("chat.send", {
      messages: [{ role: "user", content: "hi" }],
      toolNames: ["bash"],
    });
    const ctx = fx.ctx();
    assert.deepEqual(ctx.toolNames, ["bash"]);
    assert.equal(ctx.loops, undefined);
    assert.equal(ctx.persona, undefined);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
