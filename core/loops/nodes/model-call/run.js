"use strict";

// Node model-call: one model request plus its step lifecycle, overflow retry,
// assistant persistence and token anchor.
const compaction = require("../../../compaction");
const planMode = require("../../../plan-mode");
const { TurnError } = require("../../../turn-error");

module.exports = async function run(input, ctx) {
  const { services, session, target } = ctx;
  const persist = session.persist;
  const r = ctx.turn.steps;
  ctx.turn.steps = r + 1;

  const step = persist
    ? await services.store.run("step.create", { turn_id: ctx.turn.row.id, seq: ctx.turn.stepSeq++, status: "running" })
    : null;
  ctx.step = step;
  ctx.messageSeq = 0;
  const nextSeq = () => ctx.messageSeq++;
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
    ctx.userPersisted = true;
  }

  // Deferred plan-mode switch notices are appended to the live conv and
  // persisted so replay sees the same transition.
  for (const notice of planMode.takeNotices(session.id)) {
    ctx.conv.push({ role: "user", content: notice });
    if (persist && step) {
      try {
        await services.store.run("message.add", { step_id: step.id, seq: nextSeq(), role: "user", content: notice });
      } catch (e) {
        ctx.emit({ type: "error", error: "persist plan-mode notice failed: " + (e.message || e) });
      }
    }
  }

  let requestSystem = ctx.plan.requestSystem || ctx.system;
  ctx.conv[0].content = requestSystem;
  let answer;
  let overflowRetried = false;
  for (;;) {
    try {
      answer = await services.model.stream({
        messages: ctx.conv,
        toolDefs: ctx.tools.defs,
        model: target.model,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        effort: target.effort,
        onEvent: ctx.emit,
        sessionId: session.id,
        stream: target.stream,
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
            conv: ctx.conv,
            system: requestSystem,
            toolDefs: ctx.tools.defs,
            model: target.model,
            trigger: "context-overflow",
            pending: ctx.pendingTurnMessages,
            onEvent: ctx.emit,
          });
        } catch (recoveryError) {
          console.warn("[compaction] overflow recovery failed:", (recoveryError && recoveryError.message) || recoveryError);
        }
        if (recovered.changed) {
          ctx.conv = recovered.conv;
          requestSystem = ctx.system + (planMode.isActive(session.id) ? "\n\n" + planMode.POLICY : "");
          ctx.conv[0].content = requestSystem;
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
      model: target.model,
      system: requestSystem,
      tools: ctx.tools.defs,
      messages: ctx.conv.slice(1),
      assistant: services.context.cleanMessage(message),
      usage: answer.usage,
    });
  }
  ctx.conv.push(message);

  const callIds = [];
  if (persist) {
    try {
      const assistantMsg = await services.store.run("message.add", {
        step_id: step.id,
        seq: nextSeq(),
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
          const call = await services.store.run("call.add", {
            reply_id: assistantMsg.id,
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

  ctx.callIds = callIds;
  ctx.message = message;
  return { output: message, next: "tool-execute" };
};
