"use strict";
const fs = require("fs");
const compaction = require("./compaction");
const tokenMeter = require("./token-meter");

// 上下文窗口解析（压缩域用）：优先 providers.json 每模型可选的 context_window，
// 其次 settings.contextWindow，最后回退 128000。与 index.js 的 resolveContextWindow 同源实现。
function resolveContextWindow({ provider, model, settings } = {}) {
  const st = settings || (typeof readSettingsSafe === "function" ? readSettingsSafe() : {});
  let providers;
  try { providers = JSON.parse(fs.readFileSync(require("path").join(__dirname, "..", "user", "providers.json"), "utf8")); } catch (_) { providers = []; }
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (provider && p && p.name !== provider) continue;
      for (const m of (p && p.models) || []) {
        const name = typeof m === "string" ? m : (m && m.name);
        if (model && name !== model) continue;
        const cw = m && typeof m === "object" ? Number(m.context_window) : NaN;
        if (Number.isFinite(cw) && cw > 0) return Math.floor(cw);
      }
    }
  }
  const fromSettings = Number(st.contextWindow);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return Math.floor(fromSettings);
  return compaction.DEFAULT_CONTEXT_WINDOW;
}

// 读取 settings（压缩域本地依赖，避免循环引用 index.js）。
function readSettingsSafe() {
  try { return JSON.parse(fs.readFileSync(require("path").join(__dirname, "..", "user", "settings.json"), "utf8")); } catch (_) { return {}; }
}

// Strip surface metadata (event seq / message id / turn seq) before a message
// reaches the provider; the request body keeps only Chat Completions fields.
function cleanMessage(message) {
  const clean = { role: message.role, content: message.content };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) clean.tool_calls = message.tool_calls;
  if (message.tool_call_id) clean.tool_call_id = message.tool_call_id;
  return clean;
}

// Message-level surface from storage: append-origin messages with every
// compaction replacement applied, each node priced with the DSH heuristic.
// Forked sessions also carry the inherited prefix; originSessionId tells them
// apart because surface_seq is per-session and collides across sessions.
async function surfaceNodes(core, sessionId) {
  const surface = await core.store.run("session.surface", { session_id: sessionId });
  return surface.nodes.map((node) => ({
    seq: node.seq,
    id: node.kind === "checkpoint" ? node.seq : node.id,
    originSessionId: node.originSessionId,
    turnSeq: node.turnSeq == null ? null : Number(node.turnSeq),
    checkpoint: node.kind === "checkpoint",
    role: node.message.role,
    tool_calls: node.message.tool_calls,
    tokens: compaction.estimateMessageTokens(node.message),
    message: node.message,
  }));
}

// Boundary selection only looks at this session's own nodes: an inherited
// segment must never be the cut point (docs/dev/session-tree.md §4.2).
function ownNodes(sessionId, surface) {
  return surface.filter((node) => node.originSessionId === sessionId);
}

// Request messages from the replayed surface + the caller's pending tail
// (current user message or a not-yet-persisted reference block).
async function requestMessages(core, sessionId, system, pending) {
  const nodes = await surfaceNodes(core, sessionId);
  return [{ role: "system", content: system }, ...nodes.map((node) => node.message), ...(pending || [])];
}

// One-shot summarization replay: the conversation's own system prompt, tools,
// and the selected span, with DSH's compaction directive appended as the final
// user message (prefix-cache reuse). Only text is accepted back.
async function summarizeMessages(core, { sessionId, system, toolDefs, input, target }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  for (const message of input) messages.push(message);
  messages.push({ role: "user", content: compaction.COMPACTION_INSTRUCTION });
  const answer = await core._stream({
    messages,
    toolDefs: toolDefs || [],
    model: target.model,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    effort: null,
    onEvent: () => {}, // never leak the summary into the live answer stream
    sessionId,
    stream: false,
    maxTokens: compaction.SUMMARY_MAX_TOKENS,
  });
  if (Array.isArray(answer.tool_calls) && answer.tool_calls.length) {
    throw new Error("summarization attempted a tool call");
  }
  const text = String(answer.content || "").trim();
  if (!text) throw new Error("summarization produced no text summary content");
  return text;
}

// Model-free pruning of oversized tool results (DSH compaction-tool-result-pruner
// defaults). Original message rows are untouched; history assembly substitutes.
async function pruneToolResults(core, sessionId) {
  const rows = await core.store.run("toolResultPrune.list", { session_id: sessionId });
  let count = 0;
  let charsRemoved = 0;
  for (const row of rows) {
    const pruned = compaction.pruneToolResultText(row.content);
    if (!pruned) continue;
    await core.store.run("toolResultPrune.save", {
      message_id: row.message_id,
      content: pruned.content,
      chars_before: pruned.charsBefore,
      chars_after: pruned.charsAfter,
    });
    count += 1;
    charsRemoved += pruned.charsBefore - pruned.charsAfter;
  }
  return { count, charsRemoved };
}

// One compaction transaction against the `compactions` table:
//   insert running (durable lock) -> summarize -> size check -> succeed with the
//   [start_seq, end_seq] span. A failed summary marks the row 'failed' and leaves
//   the surface untouched.
async function runCompaction(core, { sessionId, trigger, surface, boundary, system, toolDefs, target, onEvent = () => {} }) {
  // surface_seq 是 per-session 的，fork 继承段会与本会话撞号：边界一律按
  // (originSessionId, seq) 定位。
  const boundaryIdx = surface.findIndex(
    (node) => node.originSessionId === sessionId && node.seq === boundary.seq,
  );
  if (boundaryIdx < 0) return { ok: false, error: "selected surface node is gone" };
  const shadowed = surface.slice(0, boundaryIdx + 1);
  if (!shadowed.length) return { ok: false, error: "no compactable history yet" };
  const input = shadowed.map((node) => cleanMessage(node.message));
  const tokensBefore = shadowed.reduce((total, node) => total + node.tokens, 0);
  const turnSeqs = new Set(
    shadowed
      .filter((node) => node.originSessionId === sessionId && !node.checkpoint && node.turnSeq != null)
      .map((node) => node.turnSeq),
  );
  // fork 会话的摘要覆盖整条历史（含继承段），start_seq 记 0 作哨兵。
  const fork = await core.store.run("sessionFork.get", { child_session_id: sessionId });
  const range = { start: fork ? 0 : shadowed[0].seq, end: boundary.seq };

  let record;
  try {
    record = await core.store.run("compaction.start", {
      session_id: sessionId,
      trigger,
      boot: core.bootId,
    });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  onEvent({ type: "compaction", phase: "start", trigger, turns: turnSeqs.size, tokensBefore });

  try {
    const summary = await summarizeMessages(core, { sessionId, system, toolDefs, input, target });
    const framed = compaction.checkpointMessage(summary);
    const tokensAfter = compaction.estimateMessageTokens(framed);
    if (tokensAfter >= tokensBefore) {
      throw new Error("summary is not smaller than the shadowed content (" + tokensAfter + " >= " + tokensBefore + ")");
    }
    const content = await core.store.run("content.add", { content: summary });
    await core.store.run("compaction.succeed", {
      id: record.id,
      summary_content_id: content.id,
      start_seq: range.start,
      end_seq: range.end,
      provider: target.provider,
      model: target.model,
    });
    onEvent({ type: "compaction", phase: "done", trigger, turns: turnSeqs.size, tokensBefore, tokensAfter });
    return {
      ok: true,
      compactionId: record.id,
      trigger,
      boundary: boundary.seq,
      boundaryTurnSeq: boundary.turnSeq == null ? null : boundary.turnSeq,
      turns: turnSeqs.size,
      tokensBefore,
      tokensAfter,
      summary,
      shadowedRange: range,
    };
  } catch (error) {
    const message = String((error && error.message) || error);
    try {
      await core.store.run("compaction.fail", { id: record.id, error: message });
    } catch (failError) {
      console.warn("[compaction] marking the compaction row failed:", (failError && failError.message) || failError);
    }
    onEvent({ type: "compaction", phase: "failed", trigger, error: message });
    return { ok: false, error: message };
  }
}

// Manual /compact: idle session only, DSH's retainTokens=0 → keep the last
// balanced surface unit and compact everything before it.
async function compactSession(core, { sessionId, model, onEvent = () => {} } = {}) {
  if (!core.store) return { ok: false, error: "storage not initialized" };
  if (!sessionId) return { ok: false, error: "compact requires a session" };
  if (core.activeSessions.has(String(sessionId))) {
    return { ok: false, error: "compact requires an idle session: a turn is running" };
  }
  const key = String(sessionId);
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  core.compacting.set(key, gate);
  try {
    const active = await core.store.run("compaction.active", { session_id: sessionId, boot: core.bootId });
    if (active) return { ok: false, error: "compaction already in progress" };
    const surface = await surfaceNodes(core, sessionId);
    const boundary = compaction.selectTailBoundary(ownNodes(sessionId, surface));
    if (!boundary) return { ok: false, error: "no compactable history yet" };
    const st = readSettingsSafe();
    const target = core._resolveTarget(model);
    const system = await core.store.run("session.prompt", { session_id: sessionId });
    const toolDefs = core._toolDefs(core._selectTools());
    return await runCompaction(core, {
      sessionId,
      trigger: "manual",
      surface,
      boundary,
      system,
      toolDefs,
      target: { ...target, provider: st.provider || null },
      onEvent,
    });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    core.compacting.delete(key);
    releaseGate();
  }
}

// Automatic policy before one model request: prune first, then summarize when
// still above the pressure threshold (or after a context-overflow rejection).
async function maybeCompactStep(core, { sessionId, conv, system, toolDefs, model, trigger = "pressure", pending, onEvent = () => {} }) {
  if (!core.store || !sessionId) return { conv, changed: false };
  const st = readSettingsSafe();
  if (st.autoCompact === false) return { conv, changed: false };
  const window = resolveContextWindow({ provider: st.provider, model, settings: st });
  const thresholdTokens = Math.floor(window * compaction.AUTO_THRESHOLD_RATIO);
  const isOverflow = trigger === "context-overflow";
  const pendingMessages = pending ? pending() : [];
  const anchor = await core.store.run("tokenAnchor.get", { session_id: sessionId });
  let measurement = tokenMeter.measure({
    messages: conv.slice(1),
    system,
    tools: toolDefs,
    model,
    anchor,
  });
  if (!isOverflow && measurement.total < thresholdTokens) return { conv, changed: false };

  const active = await core.store.run("compaction.active", { session_id: sessionId, boot: core.bootId });
  if (active) {
    console.warn("[compaction] another compaction holds the lock; skipping automatic pass");
    return { conv, changed: false };
  }
  let current = conv;
  let changed = false;

  // Phase 1: model-free tool-result pruning.
  try {
    const pruned = await pruneToolResults(core, sessionId);
    if (pruned.count > 0) {
      current = await requestMessages(core, sessionId, system, pendingMessages);
      changed = true;
      measurement = tokenMeter.measure({ messages: current.slice(1), system, tools: toolDefs, model, anchor });
      onEvent({ type: "compaction", phase: "prune", trigger, count: pruned.count, charsRemoved: pruned.charsRemoved });
    }
  } catch (error) {
    console.warn("[compaction] tool-result pruning failed:", (error && error.message) || error);
  }
  if (!isOverflow && measurement.total < thresholdTokens) return { conv: current, changed };

  // Phase 2: summarize the span older than the retained tail. The tail budget
  // counts the pending user message so it is never compacted.
  const surface = await surfaceNodes(core, sessionId);
  const own = ownNodes(sessionId, surface);
  const boundary = isOverflow
    ? compaction.selectTailBoundary(own)
    : compaction.selectAutoBoundary(
      own,
      Math.floor(window * compaction.AUTO_RETAIN_RATIO),
      compaction.estimateMessagesTokens(pendingMessages),
    );
  if (!boundary) return { conv: current, changed };

  const result = await runCompaction(core, {
    sessionId,
    trigger,
    surface,
    boundary,
    system,
    toolDefs,
    target: { model, baseUrl: core.baseUrl, apiKey: core.apiKey, provider: st.provider || null },
    onEvent,
  });
  if (result.ok) {
    current = await requestMessages(core, sessionId, system, pendingMessages);
    changed = true;
    measurement = tokenMeter.measure({ messages: current.slice(1), system, tools: toolDefs, model, anchor });
    if (!isOverflow && measurement.total >= thresholdTokens) {
      console.warn("[compaction] still above the pressure threshold after one compaction pass (retained tail is over budget)");
    }
  }
  return { conv: current, changed };
}

module.exports = {
  resolveContextWindow,
  surfaceNodes,
  requestMessages,
  summarizeMessages,
  pruneToolResults,
  runCompaction,
  compactSession,
  maybeCompactStep,
};
