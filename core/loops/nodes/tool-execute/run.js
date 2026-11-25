"use strict";

// Node tool-execute: validate → authorize → execute → persist each tool call.
// Plan review, user questions, user jobs, subagent delegation and run_code's
// nested calls all happen inside tool execution, not as separate graph phases.
import { permissionFor } from "./../../../permissions.js";
import _mod0 from "./../../../fs-policy.js";
const { resolveFsPermissionForPaths, fsPathsForTool } = _mod0;
import { validateToolArgs, runTool, createDeferContext } from "./../../../tools/executor.js";
import { errorResult, modelContent } from "./../../../../lib/tool-result/index.js";
import { runProgram } from "./../../../../lib/code-runner/index.js";

function parseArguments(raw) {
  let args = {};
  let invalid = null;
  try {
    args = JSON.parse(raw || "{}");
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      invalid = "invalid arguments: arguments must be a JSON object";
    }
  } catch (e) {
    invalid = "invalid arguments: " + (e.message || String(e));
  }
  return { args, invalid };
}

export default async function run(input, ctx) {
  const { agent, services, session } = ctx;
  const response = ctx.step.response;
  const persist = session.persist;

  if (!response.tool_calls || !response.tool_calls.length) {
    return { output: response, next: "decide-next" };
  }

  const parentChatCtx = {
    toolNames: ctx.toolNames,
    model: ctx.request.model,
    effort: ctx.request.effort,
    stream: ctx.request.stream,
    activity: agent.turn.activity,
    autonomy: agent.turn.autonomy,
  };

  // Nested calls may only reach the tools the model could see in this round.
  const allowedNested = new Set(
    Array.isArray(ctx.request.nestedToolNames)
      ? ctx.request.nestedToolNames
      : (ctx.request.selected || []).map((tool) => tool.name).filter((name) => name !== "run_code"),
  );

  let nestedSeq = 0;

  // Every tool execution gets the same capability bag. The callId and signal
  // differ so approvals, delegation and cancellation stay attributed correctly.
  const makeExec = ({ callId, name, signal, tool = null, allowRunCode = false, nestedCall }) => {
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
      waitAgent: (a) => services.subagents.waitAgent({ ...a, callerSessionId: session.id, signal }),
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
        signal,
      }),
    } : null;

    const startJob = services.jobs ? (spec) => services.jobs.start({
      ...spec,
      sessionId: session.id,
      chatCtx: parentChatCtx,
      onEvent: ctx.emit,
    }) : null;

    return {
      cwd: ctx.cwd,
      signal,
      sessionId: session.id,
      callId,
      toolName: name,
      // The tool object itself: tools read their own toolpack configuration
      // from here (docs/tools/toolpack.md), so they never reach into core.
      tool: tool || null,
      agent,
      goals: services.goals,
      context: services.context,
      registry: ctx.runtime && ctx.runtime.registry ? ctx.runtime.registry : null,
      deferContext: createDeferContext(agent.turn ? agent.turn.deferred : null),
      isPlanMode: () => agent.planPolicyActive(),
      reviewPlan: (plan) => services.interactions.requestPlanReview({ agent, callId, plan, sessionId: session.id }),
      askUserQuestion: (questions) => services.interactions.requestUserQuestion({ agent, callId, questions }),
      requestApproval: (payload) => services.interactions.requestApproval(Object.assign({ agent }, payload)),
      requestUserJob: (job) => services.interactions.requestUserJob({ agent, callId, sessionId: session.id, ...job }),
      killUserJob: (jobId) => services.interactions.killUserJob(jobId),
      store: services.store,
      capabilities: services.capabilities,
      jobs: services.jobs,
      terminals: services.terminals,
      lsp: services.lsp,
      team: services.team,
      schedule: services.schedule,
      a2a: services.a2a,
      browser: services.browser,
      startJob,
      emit: ctx.emit,
      ...delegation,
      workflowEngine,
      ...(allowRunCode ? {
        runCode: (request) => runProgram({
          ...request,
          cwd: ctx.cwd,
          callTool: ({ name: nestedName, args: nestedArgs, callId: nestedCallId, signal: nestedSignal }) =>
            executeNested(nestedName, nestedArgs, {
              signal: nestedSignal || request.signal,
              parentCallId: nestedCallId,
            }),
        }),
      } : {}),
      ...(nestedCall ? { nested: true } : {}),
    };
  };

  const authorize = async (name, args, callId, tool) => {
    let permission = permissionFor(ctx.request.permissions, name);
    if (tool && tool.group === "fs" && tool.mode === "write") {
      permission = resolveFsPermissionForPaths(
        ctx.request.permissions,
        ctx.request.fsPolicy,
        name,
        fsPathsForTool(name, args),
        ctx.cwd,
      );
    }
    let decision;
    if (permission === "ask") {
      decision = await services.interactions.requestApproval({ agent, callId, name, args, permission });
    } else {
      ctx.emit({ type: "approval-request", callId, name, arguments: args, permission });
      decision = permission === "allow" ? "approve" : "deny";
    }
    if (decision === "approve") return { ok: true };
    return {
      ok: false,
      result: errorResult(permission === "deny" ? "permission denied" : "user denied"),
    };
  };

  // run_code's tools.<name>(...) bridge. It never persists or appends model
  // messages: only the program's own inspect output reaches the parent result.
  const executeNested = async (name, args, { signal, parentCallId } = {}) => {
    if (name === "run_code") {
      return errorResult('tool "run_code" cannot be called from inside run_code');
    }
    if (!allowedNested.has(name)) {
      return errorResult('unknown tool "' + name + '"');
    }
    const tool = services.tools.get(name);
    if (!tool) return errorResult('unknown tool "' + name + '"');
    const violations = validateToolArgs(tool, args || {});
    if (violations.length > 0) return errorResult("invalid arguments: " + violations.join("; "));

    const callId = "run_code:" + (parentCallId || "call") + ":" + (++nestedSeq);
    const denial = await authorize(name, args, callId, tool);
    if (!denial.ok) {
      ctx.emit({ type: "tool_call", id: callId, name, arguments: args, nested: true });
      ctx.emit({ type: "tool_result", id: callId, name, content: denial.result.text, isError: true, nested: true });
      return denial.result;
    }

    ctx.emit({ type: "tool_call", id: callId, name, arguments: args, nested: true });
    ctx.turn.toolsUsed += 1;
    const result = await runTool(tool, args, makeExec({
      callId,
      name,
      signal,
      tool,
      nestedCall: true,
    }));
    ctx.emit({
      type: "tool_result",
      id: callId,
      name,
      content: result.text,
      isError: result.isError === true,
      meta: result.meta,
      nested: true,
    });
    return result;
  };

  for (let i = 0; i < response.tool_calls.length; i++) {
    const call = response.tool_calls[i];
    const name = (call.function && call.function.name) || "unknown";
    const callId = call.id || "call_" + ctx.turn.stepSeq + "_" + i;
    ctx.turn.toolsUsed += 1;
    const tool = services.tools.get(name);

    // Parse + validate before approval: malformed arguments never need a prompt.
    const parsed = parseArguments(call.function && call.function.arguments);
    let { args, invalid } = parsed;
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
      ctx.request.messages.push({ role: "tool", tool_call_id: callId, content: modelContent(result) });
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

    const denial = await authorize(name, args, callId, tool);
    if (!denial.ok) {
      await finish(denial.result, "denied");
      continue;
    }

    ctx.emit({ type: "tool_call", id: callId, name, arguments: args });
    const result = await runTool(tool, args, makeExec({
      callId,
      name,
      signal: ctx.signal,
      tool,
      allowRunCode: name === "run_code",
    }));
    await finish(result, result.isError === true ? "failed" : "succeeded");
  }

  if (persist) {
    try { await services.store.run("step.update", { id: ctx.step.row.id, status: "succeeded" }); }
    catch (e) { ctx.emit({ type: "error", error: "step.update failed: " + (e.message || e) }); }
  }
  return { output: response, next: "decide-next" };
};
