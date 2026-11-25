"use strict";

// Node decide-next: termination and step-loop control.
import { TurnError } from "./../../../turn-error.js";

export default async function run(input, ctx) {
  const { agent, services, session } = ctx;
  const response = ctx.step.response;
  const persist = session.persist;

  if (response.finish_reason === "length") {
    throw new TurnError("truncated", "model response truncated (finish_reason=length)");
  }

  // Cancellation lands here, not mid-tool: a tool body that already started has
  // run to completion and reported its own abort, so the turn stops before
  // asking the model for another step instead of abandoning work in flight.
  // The turn ended because the user asked it to, not because it failed: it
  // closes normally and carries `stopReason` so the UI can tell it apart.
  if (ctx.signal && ctx.signal.aborted) {
    ctx.emit({ type: "done", message: response, stopReason: "interrupted" });
    if (persist) {
      try { await services.store.run("step.update", { id: ctx.step.row.id, status: "succeeded" }); }
      catch (e) { ctx.emit({ type: "error", error: "step.update failed: " + (e.message || e) }); }
      try { await services.store.run("turn.update", { id: ctx.turn.row.id, status: "succeeded" }); }
      catch (e) { ctx.emit({ type: "error", error: "turn.update failed: " + (e.message || e) }); }
    }
    return { output: response, done: true };
  }

  // A message may arrive while the model is producing a final answer. Do not
  // strand it in nextStep: give the agent one more step to see it before the
  // turn closes. The next pre-step claims the queue exactly once.
  if (!response.tool_calls && agent && typeof agent.peekNextStep === "function" && agent.peekNextStep().length > 0) {
    return { output: response, next: "pre-step" };
  }

  if (!response.tool_calls) {
    if (!String(response.content || "").trim()) {
      throw new TurnError("empty-response", "model returned no content and no tool calls");
    }
    ctx.emit({ type: "done", message: response });
    if (persist) {
      try { await services.store.run("step.update", { id: ctx.step.row.id, status: "succeeded" }); }
      catch (e) { ctx.emit({ type: "error", error: "step.update failed: " + (e.message || e) }); }
      try { await services.store.run("turn.update", { id: ctx.turn.row.id, status: "succeeded" }); }
      catch (e) { ctx.emit({ type: "error", error: "turn.update failed: " + (e.message || e) }); }
    }
    return { output: response, done: true };
  }

  return { output: response, next: "pre-step" };
};
