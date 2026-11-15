"use strict";

// Bare-chat is a session-mode layer, not a third loop engine (see docs/runtime/agent-mode.md).
// It is a stateless, single-request chat entry: no sessionId, no persistence,
// no tools, no step/turn store usage. The system prompt is assembled per turn.
// It mirrors the linear engine's translation and termination/log contract so
// the UI's flat renderer (onChatEventFlat / handleTranslationFlat) behaves the
// same as a persisted turn.

const {
  resolveConfig: resolveTranslateConfig,
  shouldTranslateUser,
  shouldTranslateAssistant,
  translateText,
} = require("./translation");
const { assembleSystemPrompt, DEFAULT_IDENTITY } = require("./system-prompt");
const { TurnError } = require("./turn-error");

async function runBareChat(core, ctx) {
  // ctx = { messages, model, effort, stream, onEvent }.
  // Any sessionId in ctx is intentionally ignored: bare-chat never persists.
  const {
    messages,
    model,
    effort,
    stream = false,
    onEvent = () => {},
  } = ctx;

  core.agent.emit = onEvent;
  core.agent.effort = effort || null;

  // Termination/log state. steps=1, tools=0, persist=false (no activeSessions,
  // no turn/step updates). The [turn] log uses session=none turn=-.
  const startedAt = Date.now();
  let status = "succeeded";
  let reason = "no-tool-calls";
  let errorText = null;
  const steps = 1;
  const toolsUsed = 0;

  try {
    const st = core.config.readSettings();
    const translateCfg = resolveTranslateConfig(st);

    // The last message must be a user message.
    if (!Array.isArray(messages) || !messages.length) {
      throw new TurnError("invalid-input", "the last message must be a user message");
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") {
      throw new TurnError("invalid-input", "the last message must be a user message");
    }

    // Input translation: the model must only see English. A failure blocks the
    // turn; UI restores the composer and asks the user to send English instead.
    // The copy sent to the model replaces the last user content with the English
    // translation; the UI keeps the original in bareHistory.
    let translatedUser = null;
    if (translateCfg.enabled && shouldTranslateUser(last.content, translateCfg)) {
      onEvent({ type: "translation", role: "user", phase: "start", sourceLang: "zh", targetLang: "en", source: last.content });
      try {
        translatedUser = await translateText({ text: last.content, target: "en", config: translateCfg, sessionId: undefined, timeoutMs: translateCfg.inputTimeoutMs });
        onEvent({ type: "translation", role: "user", phase: "done", sourceLang: "zh", targetLang: "en", source: last.content, text: translatedUser });
      } catch (e) {
        const message = String((e && e.message) || e);
        onEvent({ type: "translation", role: "user", phase: "error", sourceLang: "zh", targetLang: "en", source: last.content, error: message });
        throw new TurnError("translation-error", "input translation failed: " + message);
      }
    }

    // Per-turn system prompt: tools=[] so no tool:* sections. No caching, no
    // DB read, and no system-prompt event (the flat renderer ignores it).
    const target = core.config.resolveTarget({ provider: st.provider, model });
    const system = assembleSystemPrompt({
      identity: typeof st.identity === "string" ? st.identity : DEFAULT_IDENTITY,
      persona: typeof st.persona === "string" ? st.persona : "",
      tools: [],
      cwd: process.cwd(),
      model: target.model,
    }).system;

    const translatedMessages = messages.slice();
    if (translatedUser != null) {
      translatedMessages[translatedMessages.length - 1] = Object.assign({}, last, { content: translatedUser });
    }
    const requestMessages = [{ role: "system", content: system }, ...translatedMessages];

    // Single model request, no step loop, no tool calls. tools are hard-forced
    // to empty here regardless of what the UI passes.
    let a;
    try {
      a = await core.model.stream({
        messages: requestMessages,
        toolDefs: [],
        model: target.model,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        onEvent,
        sessionId: undefined,
        stream,
        effort,
      });
    } catch (e) {
      throw new TurnError("model-request-error", String((e && e.message) || e));
    }

    const message = {
      role: "assistant",
      content: a.content,
      reasoning_content: a.reasoning_content,
      tool_calls: a.tool_calls,
      finish_reason: a.finish_reason,
    };

    // Termination order (mirror linear): truncated -> empty-response -> done.
    if (a.finish_reason === "length") {
      throw new TurnError("truncated", "model response truncated (finish_reason=length)");
    }
    if (!message.tool_calls && !String(message.content || "").trim()) {
      throw new TurnError("empty-response", "model returned no content and no tool calls");
    }

    // Output translation (display-only, never blocks the answer).
    if (shouldTranslateAssistant(message.content, translateCfg)) {
      onEvent({ type: "translation", role: "assistant", phase: "start", sourceLang: "en", targetLang: "zh", source: message.content });
      try {
        const translated = await translateText({ text: message.content, target: "zh", config: translateCfg, sessionId: undefined, timeoutMs: translateCfg.outputTimeoutMs });
        onEvent({ type: "translation", role: "assistant", phase: "done", sourceLang: "en", targetLang: "zh", source: message.content, text: translated });
      } catch (e) {
        onEvent({
          type: "translation",
          role: "assistant",
          phase: "error",
          sourceLang: "en",
          targetLang: "zh",
          source: message.content,
          error: String((e && e.message) || e),
        });
      }
    }

    onEvent({ type: "done", message });
    return message;
  } catch (err) {
    // Expected terminations (request/truncation/empty/translation) and unknown
    // exceptions converge here; no done event on failure.
    status = "failed";
    reason = err instanceof TurnError ? err.reason : "unexpected-exception";
    errorText = String((err && err.message) || err);
    return { role: "assistant", content: "", error: errorText, stopReason: reason };
  } finally {
    const durationMs = Date.now() - startedAt;
    console.log("[turn] session=none turn=- status=" + status + " reason=" + reason +
      " steps=" + steps + " tools=" + toolsUsed + " duration=" + durationMs + "ms" +
      (errorText ? " error=" + JSON.stringify(errorText.slice(0, 300)) : ""));
    onEvent({ type: "turn-end", status, reason, steps, tools: toolsUsed, durationMs, error: errorText || undefined });
    onEvent({ type: "model-http-status", state: "on-wait" });
  }
}

module.exports = { runBareChat };
