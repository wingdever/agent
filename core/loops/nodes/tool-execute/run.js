"use strict";

// Node tool-execute: validate → authorize → execute → persist each tool call.
// Plan review, user questions, user jobs and subagent delegation all happen
// inside tool execution, not as separate graph phases.
const { permissionFor } = require("../../../permissions");
const { resolveFsPermission } = require("../../../fs-policy");
const { validateToolArgs, runTool } = require("../../../tools/executor");
const { errorResult } = require("../../../../lib/tool-result");

module.exports = async function run(input, ctx) {
  const { agent, services, session } = ctx;
  const response = ctx.step.response;
  const persist = session.persist;

  if (!response.tool_calls || !response.tool_calls.length) {
    return { output: response, next: "decide-next" };
  }

  for (let i = 0; i < response.tool_calls.length; i++) {
    const call = response.tool_calls[i];
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
      ctx.request.messages.push({ role: "tool", tool_call_id: callId, content: result.text });
      if (persist && ctx.step.callIds[i] != null) {
        try {
          await services.store.run("call.update", {
            id: ctx.step.callIds[i],
            status,
            result: { text: result.text, meta: result.meta, isError: result.isError === true },
          });
        } catch (e) { ctx.emit({ type: "error", error: "call.update failed: " + (e.message || e) }); }
        try {
          await services.store.run("message.add", {
            step_id: ctx.step.row.id,
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

      let permission = permissionFor(ctx.request.permissions, name);
      if (name === "write" || name === "edit") {
        permission = resolveFsPermission(ctx.request.permissions, ctx.request.fsPolicy, name, args && args.file_path, ctx.cwd);
      }
    let decision;
    if (permission === "ask") {
      decision = await services.interactions.requestApproval({ agent, callId, name, args, permission });
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
      model: ctx.request.model,
      effort: ctx.request.effort,
      stream: ctx.request.stream,
      activity: agent.turn.activity,
      autonomy: agent.turn.autonomy,
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
      subagentStartChild: (a) => services.subagents.startChild(a),
    } : {};

    const workflowEngine = services.workflow ? {
      // The workflow tool owns the run's lifecycle; here it only gets the
      // ability to start one attributed to the calling agent and session.
      start: (request) => services.workflow.start({
        ...request,
        parent: {
          sessionId: session.id,
          parentChatCtx,
          onEvent: ctx.emit,
        },
        signal: ctx.signal,
      }),
    } : null;

    const result = await runTool(tool, args, {
      cwd: ctx.cwd,
      sessionId: session.id,
      callId,
      toolName: name,
      // The calling instance, for tools that need identity (plan mode, todos).
      agent,
      goals: services.goals,
      isPlanMode: () => agent.planPolicyActive(),
      reviewPlan: (plan) => services.interactions.requestPlanReview({ agent, callId, plan, sessionId: session.id }),
      askUserQuestion: (questions) => services.interactions.requestUserQuestion({ agent, callId, questions }),
      requestApproval: (payload) => services.interactions.requestApproval(Object.assign({ agent }, payload)),
      requestUserJob: (job) => services.interactions.requestUserJob({ agent, callId, sessionId: session.id, ...job }),
      killUserJob: (jobId) => services.interactions.killUserJob(jobId),
      store: services.store,
      ...delegation,
      workflowEngine,
    });
    await finish(result, result.isError === true ? "failed" : "succeeded");
  }

  if (persist) {
    try { await services.store.run("step.update", { id: ctx.step.row.id, status: "succeeded" }); }
    catch (e) { ctx.emit({ type: "error", error: "step.update failed: " + (e.message || e) }); }
  }
  return { output: response, next: "decide-next" };
};
