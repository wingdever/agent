"use strict";

// 节点 decide-next：终止判定与 step 循环控制（对应 linear 主循环尾部与收尾块）。
//
// 注意：输出翻译（仅最终回答、历史保持英文）由挂在 model-request.after 的 translate hook
// 注入完成（见 docs/agent-loop-node-graph.md §7），本节点不再重复翻译。
//
// - finish_reason === "length" → 抛 TurnError("truncated")。
// - 无 tool_calls：
//     · 空回复（无内容） → 抛 TurnError("empty-response")。
//     · 否则：发 done 事件、persist step/turn 成功，返回 done:true 结束整轮。
// - 有 tool_calls → 返回 { next: "auto-compact" } 构成 step 循环（无步数上限，与 linear 一致）。

const { TurnError } = require("../../../turn-error");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  const message = ctx.message;
  const persist = ctx.persist;
  const step = ctx.step;

  if (message.finish_reason === "length") {
    throw new TurnError("truncated", "model response truncated (finish_reason=length)");
  }

  if (!message.tool_calls) {
    if (!String(message.content || "").trim()) {
      throw new TurnError("empty-response", "model returned no content and no tool calls");
    }
    onEvent({ type: "done", message });
    if (persist) {
      try { await core.store.run("step.update", { id: step.id, status: "succeeded" }); }
      catch (e) { onEvent({ type: "error", error: "step.update failed: " + (e.message || e) }); }
      try { await core.store.run("turn.update", { id: ctx.turn.id, status: "succeeded" }); }
      catch (e) { onEvent({ type: "error", error: "turn.update failed: " + (e.message || e) }); }
    }
    return { output: message, done: true };
  }

  // 仍有 tool_calls：回到 auto-compact 发起下一轮 step。
  return { output: message, next: "auto-compact" };
};
