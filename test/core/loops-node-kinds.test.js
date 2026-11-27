"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import nodeGraph from "../../core/loops/node-graph.js";
const { NodeGraphEngine } = nodeGraph;
import { loadNodes, NODE_KINDS } from "../../core/loops/registry.js";
import channelListenRun from "../../core/loops/builtins/channel-listen/run.js";

test("registry classifies nodes into three kinds with pipe as default", () => {
  assert.deepEqual([...NODE_KINDS], ["entry", "pipe", "exit"]);
  const nodes = loadNodes();
  assert.equal(nodes.get("builtin.channel-listen").kind, "entry");
  assert.equal(nodes.get("turn-start").kind, "pipe", "legacy nodes default to pipe");
  assert.equal(nodes.has("builtin.channel-subscribe"), false, "activator node removed");
});

test("engine has no activation machinery", () => {
  const engine = new NodeGraphEngine();
  assert.equal(engine.isActivated, undefined);
  assert.equal(engine.waitForActivation, undefined);
  assert.equal(engine.activationPromise, undefined);
});

test("channel-listen entry phase injects a delivered message", async () => {
  const engine = new NodeGraphEngine();
  const ctx = {
    emit: () => {},
    input: { messages: [] },
    channelMessage: {
      eventId: "e1", conversationKey: "G1",
      messages: [{ role: "user", content: "hi" }],
    },
  };
  const result = await engine._runNode("builtin.channel-listen", { pass: true }, ctx);
  assert.deepEqual(result, { output: { pass: true } });
  assert.equal(ctx.input.messages[0].content, "hi");
});

test("agent loops replace the global hooks for a turn", async () => {
  const engine = new NodeGraphEngine();
  const before = engine.hooks["model-call"].after.length;
  const agentLoops = [
    { on: "model-call", slot: "after", target: "builtin.channel-listen" },
    { on: "model-call", slot: "after", target: "builtin.channel-listen" },
  ];
  engine._wireHooks(agentLoops);
  assert.equal(engine.hooks["model-call"].after.length, 2);
  assert.notEqual(engine.hooks["model-call"].after.length, before);
  // Global overlay hooks are cleared by _wireHooks.
  assert.equal(engine.hooks["assemble-input"].before.length, 0);
});

test("entry is configurable through ctx.entryNode", async () => {
  const engine = new NodeGraphEngine();
  const turnCtx = {
    entryNode: "builtin.channel-listen",
    channelMessage: null,
    onEvent: () => {},
  };
  const core = { interactions: {}, store: null };
  const agent = {
    sessionId: null,
    beginTurn: () => ({ finish: () => {}, signal: null, turn: { row: null, stepSeq: 0 } }),
  };
  const result = await engine.runLoop(core, { ...turnCtx, agent }, agent).catch((e) => ({ error: e.message }));
  assert.equal(result && result.error && /unknown entry node/.test(result.error), false);
});

test("channel-listen entry initializes turn-start fields for downstream hooks", async () => {
  const ctx = {
    input: { messages: [] },
    system: "sys",
    request: { messages: null, header: null },
    emit: () => {},
    channelMessage: {
      eventId: "e1", conversationKey: "G1",
      messages: [{ role: "user", content: "hi" }],
    },
    services: {
      config: { readSettings: () => ({}) },
      context: { resolveTranslateConfig: () => ({ enabled: false }) },
    },
  };
  await channelListenRun({}, ctx);
  assert.ok(Array.isArray(ctx.request.messages), "request.messages initialized");
  assert.equal(ctx.translateCfg.enabled, false, "translateCfg initialized for hooks");
});
