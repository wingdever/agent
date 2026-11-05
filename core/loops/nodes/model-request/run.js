"use strict";

// 节点 model-request：一次模型请求（含 step 生命周期与溢出重试）。
// 对应 linear 主循环内的：step.create / r=0 落库 / _stream（context-overflow 重试一次）/
// 推入 assistant / 记录 token anchor / 持久化 assistant + tool_calls 卡片。
// 请求前 conv[0].content 设为 requestSystem。溢出重试沿用 linear 的 prune/摘要恢复。

const compaction = require("../../../compaction");
const planMode = require("../../../plan-mode");
const { TurnError } = require("../../../turn-error");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  const persist = ctx.persist;

  // step 计数与生命周期。
  const r = ctx.r++;
  ctx.steps = r + 1;
  ctx.currentStep = null;
  const step = persist
    ? await core.store.run("step.create", { turn_id: ctx.turn.id, seq: ctx.stepSeq++, status: "running" })
    : null;
  ctx.currentStep = step;
  ctx.step = step;
  if (r > 0) onEvent({ type: "step-start", seq: r });

  // r=0：仅 session 首轮落 system；触发本轮的用户请求始终落入本步骤（写库失败只告警）。
  if (persist && r === 0) {
    try {
      if (ctx.systemIsNew) {
        await core.store.run("message.add", { step_id: step.id, seq: 0, role: "system", content: ctx.system });
      }
      const lastUser = [...ctx.conv].reverse().find((m) => m.role === "user");
      if (lastUser) {
        const content = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
        await core.store.run("message.add", {
          step_id: step.id,
          seq: ctx.systemIsNew ? 1 : 0,
          role: "user",
          content,
        });
      }
    } catch (e) {
      onEvent({ type: "error", error: "persist step-0 messages failed: " + (e.message || e) });
    }
    ctx.userPersisted = true;
  }

  // 请求模型（request-time：上一步工具已全部执行完才到这里）。
  ctx.conv[0].content = ctx.requestSystem;
  let a;
  let overflowRetried = false;
  for (;;) {
    try {
      a = await core._stream({
        messages: ctx.conv,
        toolDefs: ctx.toolDefs,
        model: ctx.effModel,
        onEvent,
        sessionId: ctx.sessionId,
        stream: ctx.effStream,
      });
      break;
    } catch (err) {
      const text = String((err && err.message) || err);
      if (!overflowRetried && persist && compaction.isContextOverflowError(text)) {
        overflowRetried = true;
        onEvent({ type: "compaction", phase: "overflow", trigger: "context-overflow" });
        let recovered = { changed: false };
        try {
          recovered = await core._maybeCompactStep({
            sessionId: ctx.sessionId,
            conv: ctx.conv,
            system: ctx.requestSystem,
            toolDefs: ctx.toolDefs,
            model: ctx.effModel,
            turn: ctx.turn,
            trigger: "context-overflow",
            pending: ctx.pendingTurnMessages,
            onEvent,
          });
        } catch (recoveryError) {
          console.warn("[compaction] overflow recovery failed:", (recoveryError && recoveryError.message) || recoveryError);
        }
        if (recovered.changed) {
          ctx.conv = recovered.conv;
          ctx.requestSystem = ctx.system + (planMode.isActive(ctx.sessionId) ? "\n\n" + planMode.POLICY : "");
          ctx.conv[0].content = ctx.requestSystem;
          continue;
        }
      }
      throw new TurnError("model-request-error", text);
    }
  }

  // finish_reason 属于传输层元数据，不能混进后续请求的 messages。
  const message = {
    role: "assistant",
    content: a.content,
    reasoning_content: a.reasoning_content,
    tool_calls: a.tool_calls,
    finish_reason: a.finish_reason,
  };
  if (persist) {
    await core._recordTokenAnchor({
      sessionId: ctx.sessionId,
      model: ctx.effModel,
      system: ctx.requestSystem,
      tools: ctx.toolDefs,
      messages: ctx.conv.slice(1),
      assistant: core._cleanMessage(message),
      usage: a.usage,
    });
  }
  ctx.conv.push(message);

  // 持久化助手回复与（可能的）工具调用（首轮有 system 时整体后移一位）。
  const assistantSeq = r === 0 ? (ctx.systemIsNew ? 2 : 1) : 0;
  ctx.assistantSeq = assistantSeq;
  const callIds = [];
  if (persist) {
    try {
      const assistantMsg = await core.store.run("message.add", {
        step_id: step.id,
        seq: assistantSeq,
        role: "assistant",
        content: message.content || "",
        thought: message.reasoning_content || "",
      });
      ctx.assistantMsg = assistantMsg;
      if (message.tool_calls) {
        for (let i = 0; i < message.tool_calls.length; i++) {
          const tc = message.tool_calls[i];
          let args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { args = {}; }
          const call = await core.store.run("call.add", {
            reply_id: assistantMsg.id,
            seq: i,
            name: (tc.function && tc.function.name) || "unknown",
            category: (core.tools.get(tc.function && tc.function.name) || {}).type || "unknown",
            call_id: tc.id,
            arguments: (tc.function && tc.function.arguments) || "{}",
            status: "pending",
          });
          callIds.push(call.id);
        }
      }
    } catch (e) {
      onEvent({ type: "error", error: "persist assistant failed: " + (e.message || e) });
    }
  }
  ctx.callIds = callIds;
  ctx.message = message;
  return { output: message, next: "tool-approve" };
};
