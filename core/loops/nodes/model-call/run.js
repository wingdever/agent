"use strict";

// Node model-call: one model request plus its step lifecycle, overflow retry,
// assistant persistence and token anchor.
import compaction from "./../../../compaction.js";
import planMode from "./../../../plan-mode.js";
import { TurnError } from "./../../../turn-error.js";
import { StepState } from "./../../../memory/index.js";

export default async function run(input, ctx) {
  const { agent, services, session, request } = ctx;
  const persist = session.persist;
  const r = ctx.turn.steps;
  ctx.turn.steps = r + 1;

  const step = persist
    ? await services.store.run("step.create", { turn_id: ctx.turn.row.id, seq: ctx.turn.stepSeq++, status: "running" })
    : null;
  ctx.step = new StepState({ row: step });
  const nextSeq = () => ctx.step.nextSeq();
  ctx.nextSeq = nextSeq;
  if (r > 0) ctx.emit({ type: "step-start", seq: r });

  // r=0: persist system / catalog / user before the request. Persistence
  // failures only warn; the model response is still usable.
  if (persist && r === 0) {
    try {
      if (ctx.systemIsNew) {
        await services.store.run("message.add", { step_id: step.id, seq: nextSeq(), role: "system", content: ctx.system });
        if (ctx.catalogMsg) {
          await services.store.run("message.add", { step_id: step.id, seq: nextSeq(), role: "user", content: ctx.catalogMsg.content });
        }
      }
      const userContent = typeof ctx.pendingUser.content === "string"
        ? ctx.pendingUser.content
        : JSON.stringify(ctx.pendingUser.content);
      await services.store.run("message.add", {
        step_id: step.id,
        seq: nextSeq(),
        role: "user",
        content: userContent,
        source: ctx.input.source,
      });
    } catch (e) {
      ctx.emit({ type: "error", error: "persist step-0 messages failed: " + (e.message || e) });
    }
    ctx.step.userPersisted = true;
  }

  // Deferred plan-mode switch notices are appended to the live conv and
  // persisted so replay sees the same transition.
  for (const notice of agent.takePlanNotices()) {
    request.messages.push({ role: "user", content: notice });
    if (persist && step) {
      try {
        await services.store.run("message.add", { step_id: step.id, seq: nextSeq(), role: "user", content: notice });
      } catch (e) {
        ctx.emit({ type: "error", error: "persist plan-mode notice failed: " + (e.message || e) });
      }
    }
  }

  let header = request.header || ctx.system;
  request.messages[0].content = header;
  let answer;
  let overflowRetried = false;
  for (;;) {
    try {
      answer = await services.model.stream({
        messages: request.messages,
        toolDefs: request.toolDefs,
        model: request.model,
        baseUrl: request.baseUrl,
        apiKey: request.apiKey,
        effort: request.effort,
        onEvent: ctx.emit,
        sessionId: session.id,
        stream: request.stream,
      });
      break;
    } catch (err) {
      const text = String((err && err.message) || err);
      if (!overflowRetried && persist && compaction.isContextOverflowError(text)) {
        overflowRetried = true;
        ctx.emit({ type: "compaction", phase: "overflow", trigger: "context-overflow" });
        let recovered = { changed: false };
        try {
          recovered = await services.context.maybeCompactStep({
            sessionId: session.id,
            conv: request.messages,
            system: header,
            toolDefs: request.toolDefs,
            model: request.model,
            trigger: "context-overflow",
            pending: ctx.pendingTurnMessages,
            onEvent: ctx.emit,
          });
        } catch (recoveryError) {
          console.warn("[compaction] overflow recovery failed:", (recoveryError && recoveryError.message) || recoveryError);
        }
        if (recovered.changed) {
          request.messages = recovered.conv;
          header = ctx.system + (agent.planPolicyActive() ? "\n\n" + planMode.POLICY : "");
          request.header = header;
          request.messages[0].content = header;
          continue;
        }
      }
      throw new TurnError("model-request-error", text);
    }
  }

  const message = {
    role: "assistant",
    content: answer.content,
    reasoning_content: answer.reasoning_content,
    tool_calls: answer.tool_calls,
    finish_reason: answer.finish_reason,
  };

  if (persist) {
    await services.context.recordTokenAnchor({
      sessionId: session.id,
      model: request.model,
      system: header,
      tools: request.toolDefs,
      messages: request.messages.slice(1),
      assistant: services.context.cleanMessage(message),
      usage: answer.usage,
    });
  }
  request.messages.push(message);
  ctx.step.response = message;

  const callIds = ctx.step.callIds;
  if (persist) {
    try {
      ctx.step.assistantMsg = await services.store.run("message.add", {
        step_id: step.id,
        seq: nextSeq(),
        role: "assistant",
        content: message.content || "",
        thought: message.reasoning_content || "",
      });
      if (message.tool_calls) {
        for (let i = 0; i < message.tool_calls.length; i++) {
          const tc = message.tool_calls[i];
          let args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { args = {}; }
          const call = await services.store.run("call.add", {
            reply_id: ctx.step.assistantMsg.id,
            seq: i,
            name: (tc.function && tc.function.name) || "unknown",
            category: (services.tools.get(tc.function && tc.function.name) || {}).type || "unknown",
            call_id: tc.id,
            arguments: (tc.function && tc.function.arguments) || "{}",
            status: "pending",
          });
          callIds.push(call.id);
        }
      }
    } catch (e) {
      ctx.emit({ type: "error", error: "persist assistant failed: " + (e.message || e) });
    }
  }

  return { output: message, next: "tool-execute" };
};
