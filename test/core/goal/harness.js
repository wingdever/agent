"use strict";

// End-to-end goal harness: the real node-graph loop, the real runtime, the real
// goal service and round driver, with only the model replaced by a scripted
// stub. It is the test-side counterpart of what core/index.js composes.
//
// `script(messages, call)` runs per model request and returns a completion:
//   { content, tool_calls, finish_reason } (OpenAI-shaped, as response-process
//   expects) or throws to simulate a provider failure.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../core/storage/store.js";
import { mountGoal } from "../../../core/goal/index.js";
import { AgentRuntime } from "../../../core/agent.js";
import { ContextService } from "../../../core/context/index.js";
import { ToolService } from "../../../core/tools/index.js";
import { loadTools } from "../../../core/tools/registry.js";

export function reply(content, toolCalls) {
  const raw = (value) => {
    if (!value || typeof value !== "object") return value;
    if (typeof value.content === "string") return value;
    return { content: JSON.stringify(value, null, 2) };
  };
  if (!toolCalls) return { content: raw(content), tool_calls: null, finish_reason: "stop" };
  const text = content && typeof content === "object" ? JSON.stringify(content, null, 2) : (content || "");
  return {
    content: text,
    tool_calls: toolCalls.map((call, i) => ({
      id: "call_" + i + "_" + Math.random().toString(36).slice(2, 8),
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
    })),
    finish_reason: "tool_calls",
  };
}

export function userContents(messages) {
  return messages.filter((m) => m.role === "user").map((m) => String(m.content || ""));
}

export function goalRoundInputs(messages) {
  return userContents(messages).filter((text) => text.startsWith("<goal_round>"));
}

export async function createHarness({ script, goal = {}, maxSteps = 40 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "goal-test-"));
  const store = await createStore({ path: path.join(dir, "store.db") });
  const workspace = await store.run("workspace.create", { folder_path: dir, folder_name: "goal-test" });
  const session = await store.run("session.create", {
    workspace_id: workspace.id,
    kind: "normal",
    name: "goal-test",
    activity: "research",
  });

  const tools = new ToolService(await loadTools());

  const requests = [];
  // `calls` counts completions actually produced. (A getter over a per-test
  // counter looked clean but was captured by value in the returned object.)
  let calls = 0;
  const model = {
    async stream(opts) {
      requests.push(opts.messages);
      if (calls >= maxSteps * 4) throw new Error("harness: too many model calls");
      calls += 1;
      return script(opts.messages, calls);
    },
    emitUsage() {},
  };

  const config = {
    readSettings: () => ({ model: "stub", stream: false, identity: "test identity", provider: "stub", translate: { enabled: false } }),
    resolveTarget: () => ({ model: "stub", baseUrl: null, apiKey: null }),
    resolveContextWindow: () => 128000,
    readPermissions: () => ({ default: "allow", tools: [] }),
    readFsPolicy: () => ({ rules: [] }),
    readGoalConfig: () => ({ defaultMaxGoalRounds: 256, ...goal }),
  };

  const context = new ContextService({ config, model, tools, skills: null, store });
  const agent = new AgentRuntime({ config, model, context, tools, skills: null, interactions: null, store });
  const core = { config, model, context, tools, skills: null, interactions: null, store, goals: null, agent };
  agent.setCore(core);
  // Same mounting path as the composition root: the goal module wires itself
  // over the generic turn lifecycle interfaces.
  core.goals = mountGoal(core, { defaultMaxGoalRounds: config.readGoalConfig().defaultMaxGoalRounds });
  const goals = core.goals;
  context.setRuntime(agent);

  return {
    dir,
    store,
    session,
    agent,
    goals,
    // Probe: put the live session instance in place as if the session were
    // already open when the goal is created. Its session-start edge has already
    // fired, so creating the goal afterwards leaves it armed.
    async openSession() {
      return agent.getOrCreate(session.id);
    },
    core,
    requests,
    get calls() { return calls; },
    async close() {
      try { await store.close(); } catch (_) { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Poll until `predicate` holds; the driver's rounds are asynchronous.
export async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 20 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Idle the session runtime for one macrotask turn, letting the driver finish.
export function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
