"use strict";

// Node decide-next: termination and step-loop control.
import { TurnError } from "./../../../turn-error.js";

export default async function run(input, ctx) {
  const { services, session } = ctx;
  const response = ctx.step.response;
  const persist = session.persist;

  if (response.finish_reason === "length") {
    throw new TurnError("truncated", "model response truncated (finish_reason=length)");
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
