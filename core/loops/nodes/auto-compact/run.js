"use strict";

// 节点 auto-compact：每个 step 请求前的压力压缩（DSH pre-step）。
// 先做模型无关的 tool-result pruning，仍超阈值再写 checkpoint。失败只告警、不掐断本轮，
// 与 linear 的 _maybeCompactStep 语义一致。plan-mode 的 requestSystem 在此同步。

const compaction = require("../../../compaction");
const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  // plan-mode 的 policy 是 request-scoped：每次 step 都带，exit_plan_mode 批准后下一轮消失。
  ctx.requestSystem = ctx.system + (planMode.isActive(ctx.sessionId) ? "\n\n" + planMode.POLICY : "");

  if (ctx.persist) {
    try {
      const auto = await core._maybeCompactStep({
        sessionId: ctx.sessionId,
        conv: ctx.conv,
        system: ctx.requestSystem,
        toolDefs: ctx.toolDefs,
        model: ctx.effModel,
        turn: ctx.turn,
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
