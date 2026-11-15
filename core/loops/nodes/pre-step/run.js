"use strict";

// Node pre-step: per-step plan-mode policy + automatic pressure compaction.
const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { services, session } = ctx;

  if (ctx.turn.steps > 0 && planMode.applyPendingExit(session.id)) {
    ctx.emit({ type: "plan-mode", active: false });
  }
  planMode.recordHeader(session.id, planMode.isActive(session.id));
  ctx.plan.requestSystem = ctx.system + (planMode.isActive(session.id) ? "\n\n" + planMode.POLICY : "");

  if (session.persist) {
    try {
      const auto = await services.context.maybeCompactStep({
        sessionId: session.id,
        conv: ctx.conv,
        system: ctx.plan.requestSystem,
        toolDefs: ctx.tools.defs,
        model: ctx.target.model,
        trigger: "pressure",
        pending: ctx.pendingTurnMessages,
        onEvent: ctx.emit,
      });
      ctx.conv = auto.conv;
    } catch (error) {
      console.warn("[compaction] automatic pressure pass failed:", (error && error.message) || error);
    }
  }
  return { output: ctx.plan.requestSystem, next: "model-call" };
};
