"use strict";

// Node pre-step: per-step plan-mode policy + automatic pressure compaction.
// Produces the next request's header and context on the turn's RequestSpec.
const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { services, session, request } = ctx;

  if (ctx.turn.steps > 0 && planMode.applyPendingExit(session.id)) {
    ctx.emit({ type: "plan-mode", active: false });
  }
  planMode.recordHeader(session.id, planMode.isActive(session.id));
  request.planActive = planMode.isActive(session.id);
  request.header = ctx.system + (request.planActive ? "\n\n" + planMode.POLICY : "");

  if (session.persist) {
    try {
      const auto = await services.context.maybeCompactStep({
        sessionId: session.id,
        conv: request.messages,
        system: request.header,
        toolDefs: request.toolDefs,
        model: request.model,
        trigger: "pressure",
        pending: ctx.pendingTurnMessages,
        onEvent: ctx.emit,
      });
      request.messages = auto.conv;
    } catch (error) {
      console.warn("[compaction] automatic pressure pass failed:", (error && error.message) || error);
    }
  }
  return { output: request.header, next: "model-call" };
};
