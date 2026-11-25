"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../../../core/memory/agent.js";
import { SubagentRuntime } from "../../../core/subagent-runtime.js";
import waitAgentTool from "../../../tools/wait_agent/run.js";
import preStep from "../../../core/loops/nodes/pre-step/run.js";
import { loadTools } from "../../../core/tools/registry.js";

function runningAgent(sessionId) {
  const agent = new Agent({ sessionId, persist: false });
  const handle = agent.beginTurn({ emit: () => {} });
  return { agent, handle };
}

test("wait_agent is registered in the agent group", async () => {
  const tools = await loadTools();
  const tool = tools.get("wait_agent");
  assert.ok(tool);
  assert.equal(tool.group, "agent");
  assert.equal(tool.mode, "both");
});

test("nextStep input wakes waitForNextStep without consuming it", async () => {
  const { agent, handle } = runningAgent(11);
  try {
    agent.enqueue({ id: "m1", content: "hello", source: "agent-message" }, "next-step");
    const pending = await agent.waitForNextStep({ timeoutMs: 100 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "m1");
    assert.equal(agent.peekNextStep().length, 1, "waiting must not consume");

    agent.markNextStepReported(["m1"]);
    const none = await agent.waitForNextStep({ timeoutMs: 70 });
    assert.equal(none, null, "already reported input must not wake again");

    const claimed = agent.claimNextStep();
    assert.equal(claimed.length, 1);
    assert.equal(agent.peekNextStep().length, 0);
  } finally {
    handle.finish();
  }
});

test("wait_agent returns timedOut true after the timeout", async () => {
  const { agent, handle } = runningAgent(12);
  try {
    const core = { agent: { get: (id) => (Number(id) === 12 ? agent : null) } };
    const runtime = new SubagentRuntime(core, {});
    const started = Date.now();
    const result = await runtime.waitAgent({ callerSessionId: 12, timeoutMs: 10000 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started >= 9900);
  } finally {
    handle.finish();
  }
});

test("wait_agent rejects invalid timeout and a missing caller", async () => {
  const { agent, handle } = runningAgent(13);
  try {
    const core = { agent: { get: (id) => (Number(id) === 13 ? agent : null) } };
    const runtime = new SubagentRuntime(core, {});
    await assert.rejects(() => runtime.waitAgent({ callerSessionId: 13, timeoutMs: 9999 }), /timeout_ms/);
    await assert.rejects(() => runtime.waitAgent({ callerSessionId: 99, timeoutMs: 10000 }), /live caller/);
  } finally {
    handle.finish();
  }
});

test("wait_agent rejects when the turn is aborted", async () => {
  const { agent, handle } = runningAgent(14);
  try {
    const controller = new AbortController();
    const waiting = agent.waitForNextStep({ timeoutMs: 10000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => waiting, /aborted/);
  } finally {
    handle.finish();
  }
});

test("send_message to a running target lands in nextStep", async () => {
  const { agent: target, handle } = runningAgent(2);
  const store = {
    async run(name, params) {
      if (name === "subagent.get") {
        if (Number(params.sub_sess_id) === 2) return { sub_sess_id: 2, par_sess_id: 1, agent_name: "child" };
        return null;
      }
      if (name === "session.get") return { id: Number(params.id) };
      if (name === "subagent.byName") return { sub_sess_id: 2, par_sess_id: 1, agent_name: "child" };
      throw new Error("unexpected store call " + name);
    },
  };
  const core = {
    store,
    agent: {
      activeSessions: new Set(["2"]),
      get: (id) => (Number(id) === 2 ? target : null),
    },
  };
  const runtime = new SubagentRuntime(core, {});
  try {
    const result = await runtime.sendMessage({ senderSessionId: 1, agent: "child", message: "ping" });
    assert.ok(result.messageId);
    const pending = target.unreportedNextStep();
    assert.equal(pending.length, 1);
    assert.match(pending[0].content, /Agent lead sent a message: ping/);
    assert.equal(pending[0].source, "agent-message");
  } finally {
    handle.finish();
  }
});

test("pre-step claims nextStep at the step boundary", async () => {
  const { agent, handle } = runningAgent(31);
  try {
    agent.enqueue({ id: "m31", content: "steering", source: "agent-message" }, "next-step");
    const request = { messages: [{ role: "user", content: "go" }], model: "test-model", toolDefs: [] };
    const events = [];
    const ctx = {
      agent,
      services: {},
      session: { persist: false },
      turn: { steps: 0 },
      system: "system",
      request,
      pendingTurnMessages: [],
      emit: (event) => events.push(event),
    };
    await preStep({}, ctx);
    assert.equal(request.messages.length, 2);
    assert.deepEqual(request.messages[1], { role: "user", content: "steering" });
    assert.equal(ctx.pendingStepMessages.length, 1);
    assert.equal(agent.peekNextStep().length, 0);
    assert.ok(events.some((e) => e.type === "inbox" && e.messageId === "m31"));
  } finally {
    handle.finish();
  }
});

test("a running parent receives a settlement on nextStep", async () => {
  const { agent: parent, handle } = runningAgent(21);
  const calls = [];
  const store = {
    async run(name, params) {
      calls.push({ name, params });
      if (name === "session.get") return { id: 21 };
      if (name === "subagentSettle.add") return { id: 1 };
      throw new Error("unexpected store call " + name);
    },
  };
  const core = { store, agent: { get: (id) => (Number(id) === 21 ? parent : null) } };
  const runtime = new SubagentRuntime(core, {});
  try {
    await runtime._deliverSettlement({ parentSessionId: 21, delivery: "parent" }, 22, "child finished", 9);
    const pending = parent.unreportedNextStep();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].source, "subagent-settle");
    assert.equal(pending[0].content, "child finished");

    await runtime.linkSettlement({ inboxId: pending[0].id, messageId: 77 });
    assert.ok(calls.some((c) => c.name === "subagentSettle.add"
      && c.params.output_id === 9 && c.params.settle_id === 77));
  } finally {
    handle.finish();
  }
});

test("wait_agent tool serializes timedOut and validates the range", async () => {
  const ok = await waitAgentTool.run({ timeout_ms: 10000 }, { waitAgent: async () => ({ timedOut: false, pending: 2 }) });
  assert.deepEqual(JSON.parse(ok.text), { timedOut: false });
  assert.equal(ok.meta.pending, 2);

  const tooShort = await waitAgentTool.run({ timeout_ms: 100 }, { waitAgent: async () => ({}) });
  assert.equal(tooShort.isError, true);
  assert.match(tooShort.text, /timeout_ms/);

  const unavailable = await waitAgentTool.run({}, {});
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.text, /unavailable/);
});
