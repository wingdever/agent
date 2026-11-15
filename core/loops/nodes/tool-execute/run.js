"use strict";

// Node tool-execute: validate → authorize → execute → persist each tool call.
// Plan review, user questions, user jobs and subagent delegation all happen
// inside tool execution, not as separate graph phases.
const { permissionFor } = require("../../../permissions");
const { resolveFsPermission } = require("../../../fs-policy");
const { validateToolArgs, runTool } = require("../../../tools/executor");
const { errorResult } = require("../../../tools/result");
const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { services, session } = ctx;
  const message = ctx.message;
  const persist = session.persist;

  if (!message.tool_calls || !message.tool_calls.length) {
    return { output: message, next: "decide-next" };
  }

  for (let i = 0; i < message.tool_calls.length; i++) {
    const call = message.tool_calls[i];
    const name = (call.function && call.function.name) || "unknown";
    const callId = call.id || "call_" + ctx.turn.stepSeq + "_" + i;
    ctx.turn.toolsUsed += 1;
    const tool = services.tools.get(name);

    // Parse + validate before approval: malformed arguments never need a prompt.
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
      ctx.emit({
        type: "tool_result",
        id: callId,
        name,
        content: result.text,
        isError: result.isError === true,
        meta: result.meta,
      });
      ctx.conv.push({ role: "tool", tool_call_id: callId, content: result.text });
      if (persist && ctx.callIds[i] != null) {
        try {
          await services.store.run("call.update", {
            id: ctx.callIds[i],
            status,
            result: { text: result.text, meta: result.meta, isError: result.isError === true },
          });
        } catch (e) { ctx.emit({ type: "error", error: "call.update failed: " + (e.message || e) }); }
        try {
          await services.store.run("message.add", {
            step_id: ctx.step.id,
            seq: ctx.nextSeq(),
            role: "tool",
            content: result.text,
          });
        } catch (e) { ctx.emit({ type: "error", error: "message.add failed: " + (e.message || e) }); }
      }
    };

    if (invalid) {
      ctx.emit({ type: "tool_call", id: callId, name, arguments: args });
      await finish(errorResult(invalid), "failed");
      continue;
    }

    let permission = permissionFor(ctx.tools.permissions, name);
    if (name === "write" || name === "edit") {
      permission = resolveFsPermission(ctx.tools.permissions, ctx.tools.fsPolicy, name, args && args.file_path, ctx.cwd);
    }
    let decision;
    if (permission === "ask") {
      decision = await services.interactions.requestApproval({ callId, name, args, permission });
    } else {
      ctx.emit({ type: "approval-request", callId, name, arguments: args, permission });
      decision = permission === "allow" ? "approve" : "deny";
    }
    if (decision !== "approve") {
      await finish(errorResult(permission === "deny" ? "permission denied" : "user denied"), "denied");
      continue;
    }

    ctx.emit({ type: "tool_call", id: callId, name, arguments: args });
    const parentChatCtx = {
      toolNames: ctx.toolNames,
      model: ctx.target.model,
      effort: ctx.target.effort,
      stream: ctx.target.stream,
      activity: ctx.runtime.activity,
      autonomy: ctx.runtime.autonomy,
    };
    const delegation = services.subagents ? {
      subagentSpawn: (a) => services.subagents.spawn({
        ...a,
        parentSessionId: session.id,
        parentOnEvent: ctx.emit,
        parentChatCtx,
        modelCallId: callId,
      }),
      subagentFork: (a) => services.subagents.spawnFork({
        ...a,
        parentSessionId: session.id,
        parentOnEvent: ctx.emit,
        parentChatCtx,
        modelCallId: callId,
      }),
      sendMessage: (a) => services.subagents.sendMessage(a),
      interruptAgent: (a) => services.subagents.interruptAgent(a),
      listAgents: (a) => services.subagents.listAgents(a),
    } : {};

    const result = await runTool(tool, args, {
      cwd: ctx.cwd,
      sessionId: session.id,
      callId,
      toolName: name,
      goals: services.goals,
      isPlanMode: () => planMode.isActive(session.id),
      reviewPlan: (plan) => services.interactions.requestPlanReview({ callId, plan, sessionId: session.id }),
      askUserQuestion: (questions) => services.interactions.requestUserQuestion({ callId, questions }),
      requestApproval: (payload) => services.interactions.requestApproval(payload),
      requestUserJob: (job) => services.interactions.requestUserJob({ callId, sessionId: session.id, ...job }),
      killUserJob: (jobId) => services.interactions.killUserJob(jobId),
      store: services.store,
      ...delegation,
    });
    await finish(result, result.isError === true ? "failed" : "succeeded");
  }

  if (persist) {
    try { await services.store.run("step.update", { id: ctx.step.id, status: "succeeded" }); }
    catch (e) { ctx.emit({ type: "error", error: "step.update failed: " + (e.message || e) }); }
  }
  return { output: message, next: "decide-next" };
};
