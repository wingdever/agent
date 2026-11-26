"use strict";

// Smoke tests for pause / resume (docs/runtime/turn-pause.md): one real
// node-graph turn, a scripted model, and real tools, with the pause request
// arriving from the test thread while the turn is in flight.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../core/storage/store.js";
import { AgentRuntime } from "../../../core/agent.js";
import { ContextService } from "../../../core/context/index.js";
import { ToolService } from "../../../core/tools/index.js";
import { loadTools } from "../../../core/tools/registry.js";
import { createSnapshotService } from "../../../core/snapshots/index.js";
import { RpcRegistry } from "../../../core/rpc/registry.js";
import defineTurnCommands from "../../../core/rpc/handlers/turn.js";

function quiet() {
  return { info() {}, warn() {}, error() {} };
}

// A model whose first response asks for one `get_current_time` call; the test
// pulls pause out of it while the response is being produced.
function scriptedModel({ onRequest }) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async stream() {
      calls += 1;
      if (calls === 1) {
        const response = {
          content: "",
          tool_calls: [{
            id: "call_time_1",
            type: "function",
            function: { name: "get_current_time", arguments: "{}" },
          }],
          finish_reason: "tool_calls",
        };
        if (onRequest) await onRequest(calls);
        return response;
      }
      return { content: "done", tool_calls: null, finish_reason: "stop" };
    },
    emitUsage() {},
  };
}

async function harness({ onRequest = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pause-test-"));
  const store = await createStore({ path: path.join(dir, "store.db") });
  const workspace = await store.run("workspace.create", { folder_path: dir, folder_name: "pause-test" });
  const session = await store.run("session.create", {
    workspace_id: workspace.id,
    kind: "normal",
    name: "pause-test",
    activity: "research",
  });
  const tools = new ToolService(await loadTools());
  const model = scriptedModel({ onRequest });
  const config = {
    readSettings: () => ({ model: "stub", stream: false, identity: "test identity", provider: "stub", translate: { enabled: false } }),
    resolveTarget: () => ({ model: "stub", baseUrl: null, apiKey: null }),
    resolveContextWindow: () => 128000,
    readGoalConfig: () => ({ defaultMaxGoalRounds: 256 }),
  };
  const context = new ContextService({ config, model, tools, skills: null, store });
  const agent = new AgentRuntime({ config, model, context, tools, skills: null, interactions: null, store });
  const core = { config, model, context, tools, skills: null, interactions: null, store, goals: null, agent, snapshots: null };
  agent.setCore(core);
  context.setRuntime(agent);
  core.snapshots = createSnapshotService({ store, dir: path.join(dir, "snapshots"), logger: quiet() });
  return {
    dir, store, session, agent, core, model,
    instance: () => agent.get(session.id),
    async close() {
      try { await store.close(); } catch (_) { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function waitFor(predicate, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value = false;
      try { value = predicate(); } catch (_) { value = false; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("a pause request stops the turn before its tools and continue runs them once", async (t) => {
  // The request arrives from inside the model request; the test never waits
  // for the pause from in there (the pause point is reached only after that
  // request returns).
  let h = null;
  let onRequest = async () => {};
  h = await harness({ onRequest: (n) => onRequest(n) });
  t.after(() => h.close());
  onRequest = async (n) => {
    if (n === 1) h.instance().requestPause();
  };

  const running = h.agent.chat({
    sessionId: h.session.id,
    messages: [{ role: "user", content: "what time is it" }],
    stream: false,
  });

  // The turn stops at the pause point: the tool call is persisted and pending.
  await waitFor(() => h.instance().phase.kind === "paused");
  const agent = h.instance();
  assert.equal(agent.pause.pausedAt, "before-tools");
  assert.equal(agent.pause.node, "tool-execute");

  const turn = (await h.store.run("turn.list", { session_id: h.session.id }))[0];
  const steps = await h.store.run("step.list", { turn_id: turn.id });
  const messages = await h.store.run("message.list", { step_id: steps[0].id });
  const reply = messages.filter((m) => m.role === "assistant").pop();
  let calls = await h.store.run("call.list", { reply_id: reply.id });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "pending"); // the tool has not run
  assert.equal(h.model.calls, 1); // no second model request while paused

  // turn.state reads the pending calls from the store, not from memory.
  const rpc = new RpcRegistry(h.core);
  defineTurnCommands(rpc);
  const state = await rpc.handle("turn.state", { session_id: h.session.id });
  assert.equal(state.phase, "paused");
  assert.equal(state.pausedAt, "before-tools");
  assert.equal(state.pendingCalls.length, 1);
  assert.equal(state.pendingCalls[0].name, "get_current_time");

  // Continue through the control surface, exactly as the UI does.
  assert.equal(agent.resumeTurn(), true);
  await running;
  await waitFor(() => h.model.calls === 2);
  assert.equal(h.model.calls, 2);
  await h.instance().whenIdle();
  assert.equal(h.instance().phase.kind, "idle");

  // The batch ran and its result landed with the status update.
  calls = await h.store.run("call.list", { reply_id: reply.id });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "succeeded");
});

test("a pause request met with no tool calls ends the turn normally", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pause-test-"));
  const store = await createStore({ path: path.join(dir, "store.db") });
  const workspace = await store.run("workspace.create", { folder_path: dir, folder_name: "pause-test" });
  const session = await store.run("session.create", {
    workspace_id: workspace.id, kind: "normal", name: "pause-test", activity: "research",
  });
  const tools = new ToolService(await loadTools());
  let paused = null;
  const model = {
    async stream() {
      if (paused) paused.requestPause(); // arrives during a final answer
      return { content: "answer", tool_calls: null, finish_reason: "stop" };
    },
    emitUsage() {},
  };
  const config = {
    readSettings: () => ({ model: "stub", stream: false, identity: "test identity", provider: "stub", translate: { enabled: false } }),
    resolveTarget: () => ({ model: "stub", baseUrl: null, apiKey: null }),
    resolveContextWindow: () => 128000,
    readGoalConfig: () => ({ defaultMaxGoalRounds: 256 }),
  };
  const context = new ContextService({ config, model, tools, skills: null, store });
  const agent = new AgentRuntime({ config, model, context, tools, skills: null, interactions: null, store });
  const core = { config, model, context, tools, skills: null, interactions: null, store, goals: null, agent };
  agent.setCore(core);
  context.setRuntime(agent);
  t.after(async () => {
    try { await store.close(); } catch (_) { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await agent.chat({ sessionId: session.id, messages: [{ role: "user", content: "hello" }], stream: false });
  assert.ok(result);
  assert.equal(agent.get(session.id).phase.kind, "idle");
  assert.equal(agent.get(session.id).pause.requested, false);
});

test("quitting writes a paused snapshot and starting restores it, then clears the index", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const agent = await h.agent.getOrCreate(h.session.id);
  agent.restorePause({ pausedAt: "before-tools", nextStep: [] });
  agent.inbox.nextStep.push({ id: "steer-1", content: "steer text", source: "user_input" });
  assert.equal(agent.phase.kind, "paused");

  const written = await h.core.snapshots.writeAll(h.agent.registry.list());
  assert.deepEqual(written, [String(h.session.id)]);

  // A fresh process: a new runtime sharing the store, restoring reads the
  // index back and rebuilds the paused instance.
  const agent2 = new AgentRuntime({
    config: h.core.config, model: h.core.model, context: h.core.context,
    tools: h.core.tools, skills: null, interactions: null, store: h.store,
  });
  const core2 = { ...h.core, agent: agent2 };
  agent2.setCore(core2);
  h.core.context.setRuntime(agent2);

  const again = await h.core.snapshots.restoreAll(agent2);
  assert.ok(again.includes(String(h.session.id)));
  const restored = agent2.get(h.session.id);
  assert.equal(restored.phase.kind, "paused");
  assert.equal(restored.pause.pausedAt, "before-tools");
  assert.equal(restored.inbox.nextStep.length, 1);
  assert.equal(restored.inbox.nextStep[0].content, "steer text");

  // The index is cleared on read; a second restore finds nothing.
  assert.deepEqual(await h.core.snapshots.snapshots.listIndex(), []);
  assert.deepEqual(await h.core.snapshots.restoreAll(agent2), []);
});
