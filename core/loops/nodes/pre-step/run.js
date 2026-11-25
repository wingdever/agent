"use strict";

// Node pre-step: per-step plan-mode policy + automatic pressure compaction.
// Produces the next request's header and context on the turn's RequestSpec.
import planMode from "./../../../plan-mode.js";

export default async function run(input, ctx) {
  const { agent, services, session, request } = ctx;

  if (ctx.turn.steps > 0 && agent.applyPlanExit()) {
    ctx.emit({ type: "plan-mode", active: false });
  }
  agent.recordHeaderPlanMode();
  request.planActive = agent.planPolicyActive();
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

  // The turn's claim gets a look at each step boundary: a source whose round
  // was overtaken by a competing input can invalidate its reservation here (the
  // run finishes, but no further round follows until the session is idle).
  const claim = agent.turn && agent.turn.claim;
  if (claim && typeof claim.onStep === "function") claim.onStep();

  // Step boundary: claim all nextStep inputs (agent messages and steering),
  // append them as user turns for this request, and let model-call persist them
  // with the new step id. wait_agent only marked them reported; this is the
  // actual consumption point.
  const pendingStep = agent.claimNextStep();
  ctx.pendingStepMessages = pendingStep;
  for (const item of pendingStep) {
    request.messages.push({ role: "user", content: item.content });
    ctx.emit({ type: "inbox", queue: "next-step", source: item.source, messageId: item.id });
  }

  return { output: request.header, next: "model-call" };
};
