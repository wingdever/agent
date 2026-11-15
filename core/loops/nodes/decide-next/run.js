"use strict";

// Node decide-next: termination and step-loop control.
const { TurnError } = require("../../../turn-error");

module.exports = async function run(input, ctx) {
  const { services, session } = ctx;
  const message = ctx.message;
  const persist = session.persist;

  if (message.finish_reason === "length") {
    throw new TurnError("truncated", "model response truncated (finish_reason=length)");
  }

  if (!message.tool_calls) {
    if (!String(message.content || "").trim()) {
      throw new TurnError("empty-response", "model returned no content and no tool calls");
    }
    ctx.emit({ type: "done", message });
    if (persist) {
      try { await services.store.run("step.update", { id: ctx.step.id, status: "succeeded" }); }
      catch (e) { ctx.emit({ type: "error", error: "step.update failed: " + (e.message || e) }); }
      try { await services.store.run("turn.update", { id: ctx.turn.row.id, status: "succeeded" }); }
      catch (e) { ctx.emit({ type: "error", error: "turn.update failed: " + (e.message || e) }); }
    }
    return { output: message, done: true };
  }

  return { output: message, next: "pre-step" };
};
