"use strict";

// Node resume-step: re-enter a stored step after a pause was continued
// (docs/runtime/turn-pause.md §4.5). The step's assistant message and calls
// are already in the store; this node reloads them into the turn context so
// `tool-execute` can run the pending batch exactly once.
//
// It never calls the model: continuing does not re-run the request whose
// result stopped the turn.
import { StepState } from "./../../../memory/index.js";

export default async function run(input, ctx) {
  const { agent, services } = ctx;
  const info = ctx.resume && ctx.resume.step;
  if (!info || !info.id) return { output: null, next: "tool-execute" };

  const row = await services.store.run("step.get", { id: info.id });
  const step = new StepState({ row, messageSeq: info.messageSeq || 0 });
  // The assistant reply this step already produced.
  const messages = await services.store.run("message.list", { step_id: info.id }).catch(() => []);
  const reply = (messages || []).filter((m) => m.role === "assistant").pop() || null;
  step.assistantMsg = reply;
  if (reply) {
    const calls = await services.store.run("call.list", { reply_id: reply.id }).catch(() => []);
    // tool-execute indexes callIds positionally against the response's calls,
    // so the two lists are built together below.
    ctx.step = step;
    // Only the calls that have not run are the batch to execute now.
    const pending = (calls || []).filter((c) => c.status === "pending");
    step.callIds = pending.map((c) => c.id);
    step.pendingCallCount = pending.length;
    ctx.step.response = {
      role: "assistant",
      content: "",
      tool_calls: pending.map((c) => ({
        id: c.call_id,
        type: "function",
        function: { name: c.name, arguments: c.arguments || "{}" },
      })),
      finish_reason: "tool_calls",
    };
  }
  if (agent.pause) agent._pauseStep = { id: row.id, seq: row.seq };
  return { output: ctx.step.response, next: "tool-execute" };
};
