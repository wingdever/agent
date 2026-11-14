"use strict";

// 节点 tool-approve：处理本轮全部 tool-call 的「校验 → 授权 → 执行 → 归一化结果」。
//
// 设计说明：linear 主循环对每个 tool-call 是「校验 → 请求授权 → 立即执行 → 推结果」
// 顺序交织的（见 core/loops/linear.js 的 for 循环），保证 tool_call / approval-request /
// tool_result 事件按调用顺序逐条产出。为保持 node-graph 与 linear 的事件流完全一致，
// 此处把「授权 + 执行」统一在本节点内完成（不拆分为独立的 tool-run 串行节点，否则会
// 变成「先全部授权、再全部执行」，改变事件交织顺序）。`tool-run` 节点在本引擎中作为
// 链路上的薄透传（next: plan-review），保留文档拓扑的同时不破坏事件顺序。

const { permissionFor } = require("../../../permissions");
const { resolveFsPermission } = require("../../../fs-policy");
const { validateToolArgs, runTool } = require("../../../tools/executor");
const { errorResult } = require("../../../tools/result");
const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  const message = ctx.message;
  const persist = ctx.persist;
  const step = ctx.step;
  const cwd = ctx.cwd;
  const callIds = ctx.callIds || [];
  const assistantSeq = ctx.assistantSeq;

  if (!message.tool_calls) {
    return { output: message, next: "tool-run" };
  }

  for (let i = 0; i < message.tool_calls.length; i++) {
    const call = message.tool_calls[i];
    const name = (call.function && call.function.name) || "unknown";
    const callId = call.id || "call_" + ctx.stepSeq + "_" + i;
    ctx.toolsUsed += 1;
    const tool = core.tools.get(name);

    // 解析 + 校验在授权前完成：畸形参数不需要权限弹窗，模型仍收到正常 tool result。
    let args = {};
    let invalid = null;
    try {
      args = JSON.parse((call.function && call.function.arguments) || "{}");
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        invalid = "invalid arguments: arguments must be a JSON object";
      }
    } catch (e) {
      invalid = "invalid arguments: " + (e.message || String(e));
    }
    if (!invalid && !tool) invalid = 'tool "' + name + '" not found';
    if (!invalid) {
      const violations = validateToolArgs(tool, args);
      if (violations.length > 0) invalid = "invalid arguments: " + violations.join("; ");
    }

    const finish = async (result, status) => {
      onEvent({
        type: "tool_result",
        id: callId,
        name,
        content: result.text,
        isError: result.isError === true,
        meta: result.meta,
      });
      ctx.conv.push({ role: "tool", tool_call_id: callId, content: result.text });
      if (persist && callIds[i] != null) {
        try {
          await core.store.run("call.update", {
            id: callIds[i],
            status,
            result: { text: result.text, meta: result.meta, isError: result.isError === true },
          });
        } catch (e) { onEvent({ type: "error", error: "call.update failed: " + (e.message || e) }); }
        try {
          await core.store.run("message.add", {
            step_id: step.id,
            seq: assistantSeq + 1 + i,
            role: "tool",
            content: result.text,
          });
        } catch (e) { onEvent({ type: "error", error: "message.add failed: " + (e.message || e) }); }
      }
    };

    if (invalid) {
      onEvent({ type: "tool_call", id: callId, name, arguments: args });
      await finish(errorResult(invalid), "failed");
      continue;
    }

    // 权限：allow 直接执行，deny 拒绝不询问，ask 等待用户。write/edit 额外受 fs-policy 收窄。
    let permission = permissionFor(ctx.permissions, name);
    if (name === "write" || name === "edit") {
      permission = resolveFsPermission(ctx.permissions, ctx.fsPolicy, name, args && args.file_path, cwd);
    }
    let decision;
    if (permission === "ask") {
      decision = await core.requestApproval({ callId, name, args, permission });
    } else {
      onEvent({ type: "approval-request", callId, name, arguments: args, permission });
      decision = permission === "allow" ? "approve" : "deny";
    }
    if (decision !== "approve") {
      await finish(errorResult(permission === "deny" ? "permission denied" : "user denied"), "denied");
      continue;
    }

    // 授权通过：执行工具。plan 审批 / ask_user_question / request_user_job 等通过
    // 回调在工具执行内触发（与 linear 行为一致），最终仍是模型可见文本。
    onEvent({ type: "tool_call", id: callId, name, arguments: args });
    const result = await runTool(tool, args, {
      cwd,
      sessionId: ctx.sessionId,
      callId,
      toolName: name,
      goals: core.goals,
      isPlanMode: () => planMode.isActive(ctx.sessionId),
      reviewPlan: (plan) => core.requestPlanReview({ callId, plan, sessionId: ctx.sessionId }),
      askUserQuestion: (questions) => core.requestUserQuestion({ callId, questions }),
      requestApproval: (payload) => core.requestApproval(payload),
      requestUserJob: (job) => core.requestUserJob({ callId, sessionId: ctx.sessionId, ...job }),
      killUserJob: (jobId) => core.killUserJob(jobId),
      store: core.store,
      // one-shot subagent 委派：工具据此拿到父会话上下文并发起 spawn。
      subagentSpawn: core.subagents
        ? (a) => core.subagents.spawn({
            ...a,
            parentSessionId: ctx.sessionId,
            parentOnEvent: ctx.onEvent,
            parentChatCtx: {
              toolNames: ctx.toolNames,
              model: ctx.effModel,
              effort: ctx.effort,
              stream: ctx.effStream,
              activity: ctx.activity,
              autonomy: ctx.autonomy,
            },
            modelCallId: callId,
          })
        : undefined,
    });
    await finish(result, result.isError === true ? "failed" : "succeeded");
  }

  if (persist) {
    try { await core.store.run("step.update", { id: step.id, status: "succeeded" }); }
    catch (e) { onEvent({ type: "error", error: "step.update failed: " + (e.message || e) }); }
  }
  return { output: message, next: "tool-run" };
};
