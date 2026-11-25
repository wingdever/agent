"use strict";

// The turn lifecycle contract (docs/agents/lifecycle.md): instance events, turn
// sources, their priority, and the claim-failure path. These tests use a stub
// loop engine so they exercise the interfaces rather than a feature.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../../../core/memory/agent.js";

function persistedAgent(sessionId = 1) {
  return new Agent({ sessionId, persist: true });
}

function record(agent) {
  const events = [];
  for (const name of ["session:start", "turn:start", "turn:end", "turn:cancelled", "inbox:queued", "inbox:claimed", "inbox:removed"]) {
    agent.on(name, (payload) => events.push({ name, payload }));
  }
  return events;
}

test("on() returns an unsubscribe that stops delivery", () => {
  const agent = persistedAgent();
  let count = 0;
  const off = agent.on("turn:start", () => { count += 1; });
  agent.beginTurn({ emit() {} });
  assert.equal(count, 1);
  off();
  agent.finishTurn();
  agent.beginTurn({ emit() {} });
  assert.equal(count, 1, "unsubscribed listener must not run again");
});

test("session:start is delivered exactly once, before the first turn:start", () => {
  const agent = persistedAgent();
  const events = record(agent);
  agent.beginTurn({ emit() {} });
  agent.finishTurn();
  agent.beginTurn({ emit() {} });
  assert.deepEqual(events.map((event) => event.name), [
    "session:start",
    "turn:start",
    "turn:end",
    "turn:start",
  ]);
});

test("a listener that throws does not break the turn or other listeners", () => {
  const agent = persistedAgent();
  let reached = false;
  agent.on("turn:start", () => { throw new Error("boom"); });
  agent.on("turn:start", () => { reached = true; });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    agent.beginTurn({ emit() {} });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(reached, true);
  assert.equal(agent.running(), true);
});

test("turn:end carries the terminal facts and the claim", () => {
  const agent = persistedAgent();
  const events = record(agent);
  const claim = { accept() {} };
  const handle = agent.beginTurn({ emit() {}, claim });
  handle.finish({ status: "failed", reason: "truncated", steps: 2, tools: 3, durationMs: 5 });
  const end = events.find((event) => event.name === "turn:end").payload;
  assert.equal(end.status, "failed");
  assert.equal(end.reason, "truncated");
  assert.equal(end.steps, 2);
  assert.equal(end.tools, 3);
  assert.equal(end.claim, claim);
  assert.equal(agent.running(), false);
});

test("inbox events report queue and item for every primitive", () => {
  const agent = persistedAgent();
  const events = record(agent);
  agent.enqueue({ id: "a", content: "hello", source: "user" });
  agent.claimNextTurn();
  agent.enqueue({ id: "b", content: "later", source: "agent-message" });
  agent.removeFromInbox("b");
  agent.enqueue({ id: "c", content: "again", source: "agent-message" });
  agent.requeueNextTurn({ id: "d", content: "tail", source: "agent-message" });
  assert.deepEqual(events.map((event) => event.name + ":" + (event.payload.item && event.payload.item.id)), [
    "inbox:queued:a",
    "inbox:claimed:a",
    "inbox:queued:b",
    "inbox:removed:b",
    "inbox:queued:c",
    "inbox:queued:d",
  ]);
});

test("turn:cancelled is delivered with the caller's cause", () => {
  const agent = persistedAgent();
  const events = record(agent);
  agent.beginTurn({ emit() {} });
  agent.interrupt("interrupted", "human");
  const cancelled = events.find((event) => event.name === "turn:cancelled").payload;
  assert.equal(cancelled.cause, "human");
  assert.equal(agent.phase.cancelReason, "interrupted");
});

// ---- turn sources (runtime side) ----

import { AgentRuntime } from "../../../core/agent.js";

// A runtime whose loop body is replaced: the test only cares about which input
// opened the turn.
function runtimeWith(agent) {
  const runtime = new AgentRuntime({ config: null, model: null, context: null, tools: null, skills: null, interactions: null, store: null });
  runtime.core = {};
  // The registry knows this instance; the turn body itself is stubbed.
  runtime.registry.instances.set(agent.key, agent);
  runtime.registry.getOrCreate = async () => agent;
  runtime._runLoop = async (target, ctx) => ({ opened: ctx.messages[ctx.messages.length - 1].content, source: ctx.inputSource, claim: ctx.claim });
  return runtime;
}

function idleAgent() {
  return new Agent({ sessionId: 7, persist: false });
}

test("a source opens the turn when nothing is queued", async () => {
  const agent = idleAgent();
  const runtime = runtimeWith(agent);
  runtime.registerTurnSource({ name: "goal", admit: () => ({ message: { content: "<goal_round>", source: "goal" }, claim: { accept() {} } }) });
  const result = await runtime.chat({ sessionId: 7, messages: [{ role: "user", content: "human words" }] });
  assert.equal(result.opened, "<goal_round>");
  assert.equal(result.source, "goal");
  assert.ok(result.claim, "the source's claim reaches the turn");
  // The caller's own input waits behind the source's opening input.
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.inbox.nextTurn[0].content, "human words");
});

test("a human input queued first beats every source", async () => {
  const agent = idleAgent();
  const runtime = runtimeWith(agent);
  let asked = 0;
  runtime.registerTurnSource({ name: "goal", admit: () => { asked += 1; return { message: { content: "<goal_round>", source: "goal" } }; } });
  agent.enqueue({ content: "human next", source: "user" });
  const result = await runtime.chat({ sessionId: 7, messages: [{ role: "user", content: "second" }] });
  assert.equal(result.opened, "human next");
  assert.equal(asked, 0, "a queued human input is not even considered by sources");
});

test("sources are asked by priority and ties keep registration order", async () => {
  const agent = idleAgent();
  const runtime = runtimeWith(agent);
  const seen = [];
  runtime.registerTurnSource({ name: "low", priority: -5, admit: () => { seen.push("low"); return null; } });
  runtime.registerTurnSource({ name: "first-default", admit: () => { seen.push("first-default"); return null; } });
  runtime.registerTurnSource({ name: "high", priority: 10, admit: () => { seen.push("high"); return { message: { content: "from high", source: "x" } }; } });
  const result = await runtime.chat({ sessionId: 7, messages: [{ role: "user", content: "caller" }] });
  assert.equal(result.opened, "from high");
  // Only sources above the winner were asked; lower ones never ran.
  assert.deepEqual(seen, ["high"]);
});

test("a throwing source is skipped and the next one is asked", async () => {
  const agent = idleAgent();
  const runtime = runtimeWith(agent);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    runtime.registerTurnSource({ name: "broken", priority: 10, admit: () => { throw new Error("nope"); } });
    runtime.registerTurnSource({ name: "ok", admit: () => ({ message: { content: "from ok", source: "x" } }) });
    const result = await runtime.chat({ sessionId: 7, messages: [{ role: "user", content: "caller" }] });
    assert.equal(result.opened, "from ok");
  } finally {
    console.warn = originalWarn;
  }
});

test("without any opener the caller's own input opens the turn", async () => {
  const agent = idleAgent();
  const runtime = runtimeWith(agent);
  const result = await runtime.chat({ sessionId: 7, messages: [{ role: "user", content: "just me" }] });
  assert.equal(result.opened, "just me");
  assert.equal(result.source, "user", "an empty source is the human's");
});

test("registering the same name replaces the previous source", async () => {
  const agent = idleAgent();
  const runtime = runtimeWith(agent);
  runtime.registerTurnSource({ name: "same", admit: () => ({ message: { content: "old", source: "x" } }) });
  runtime.registerTurnSource({ name: "same", admit: () => ({ message: { content: "new", source: "x" } }) });
  const result = await runtime.chat({ sessionId: 7, messages: [{ role: "user", content: "caller" }] });
  assert.equal(result.opened, "new");
  assert.equal(runtime.turnSources.length, 1);
});
