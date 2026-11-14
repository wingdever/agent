"use strict";

// 节点 auto-compact：每个 step 请求前的压力压缩（DSH pre-step）。
// 先做模型无关的 tool-result pruning，仍超阈值再写 checkpoint。失败只告警、不掐断本轮，
// 与 linear 的 _maybeCompactStep 语义一致。plan-mode 的 requestSystem 在此同步。

const compaction = require("../../../compaction");
const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  // Apply a pending plan-mode exit from a prior approved exit_plan_mode at this
  // step's pre-step (DSH's next in-turn pre-step): the rest of that tool batch
  // stayed under plan guidance; this step's requestSystem is the first without
  // the policy. Broadcast so the UI indicator settles in lockstep.
  if (planMode.applyPendingExit(ctx.sessionId)) {
    onEvent({ type: "plan-mode", active: false });
  }
  // Record the plan-active value this header observes (DSH's activeAtLastHeader
  // de-dup for switch notices), then derive the request-scoped policy section.
  planMode.recordHeader(ctx.sessionId, planMode.isActive(ctx.sessionId));
  // plan-mode 的 policy 是 request-scoped：每次 step 都带，exit_plan_mode 批准后下一轮(pre-step)消失。
  ctx.requestSystem = ctx.system + (planMode.isActive(ctx.sessionId) ? "\n\n" + planMode.POLICY : "");

  if (ctx.persist) {
    try {
      const auto = await core._maybeCompactStep({
        sessionId: ctx.sessionId,
        conv: ctx.conv,
        system: ctx.requestSystem,
        toolDefs: ctx.toolDefs,
        model: ctx.effModel,
        trigger: "pressure",
        pending: ctx.pendingTurnMessages,
        onEvent,
      });
      ctx.conv = auto.conv;
    } catch (error) {
      console.warn("[compaction] automatic pressure pass failed:", (error && error.message) || error);
    }
  }
  return { output: ctx.conv, next: "model-request" };
};
