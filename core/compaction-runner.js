"use strict";

const compaction = require("./compaction");
const tokenMeter = require("./token-meter");
const { cleanMessage } = require("./context/messages");

// Compaction primitives. All entry points take an explicit `deps` object:
//   { store, bootId, activeSessions, compacting, model, config, tools }
// so this module no longer reaches into a service bag.

// Message-level surface from storage: append-origin messages with every
// compaction replacement applied, each node priced with the DSH heuristic.
// Forked sessions also carry the inherited prefix; originSessionId tells them
// apart because surface_seq is per-session and collides across sessions.
async function surfaceNodes(deps, sessionId) {
  const surface = await deps.store.run("session.surface", { session_id: sessionId });
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
// segment must never be the cut point.
function ownNodes(sessionId, surface) {
  return surface.filter((node) => node.originSessionId === sessionId);
}

// Request messages from the replayed surface + the caller's pending tail
// (current user message or a not-yet-persisted reference block).
async function requestMessages(deps, sessionId, system, pending) {
  const nodes = await surfaceNodes(deps, sessionId);
  return [{ role: "system", content: system }, ...nodes.map((node) => node.message), ...(pending || [])];
}

// One-shot summarization replay: the conversation's own system prompt, tools,
// and the selected span, with DSH's compaction directive appended as the final
// user message (prefix-cache reuse). Only text is accepted back.
async function summarizeMessages(deps, { sessionId, system, toolDefs, input, target }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  for (const message of input) messages.push(message);
  messages.push({ role: "user", content: compaction.COMPACTION_INSTRUCTION });
  const answer = await deps.model.stream({
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

// Model-free pruning of oversized tool results. Original message rows are
// untouched; history assembly substitutes.
async function pruneToolResults(deps, sessionId) {
  const rows = await deps.store.run("toolResultPrune.list", { session_id: sessionId });
  let count = 0;
  let charsRemoved = 0;
  for (const row of rows) {
    const pruned = compaction.pruneToolResultText(row.content);
    if (!pruned) continue;
    await deps.store.run("toolResultPrune.save", {
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
async function runCompaction(deps, { sessionId, trigger, surface, boundary, system, toolDefs, target, onEvent = () => {} }) {
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
  const fork = await deps.store.run("sessionFork.get", { child_session_id: sessionId });
  const range = { start: fork ? 0 : shadowed[0].seq, end: boundary.seq };

  let record;
  try {
    record = await deps.store.run("compaction.start", {
      session_id: sessionId,
      trigger,
      boot: deps.bootId,
    });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  onEvent({ type: "compaction", phase: "start", trigger, turns: turnSeqs.size, tokensBefore });

  try {
    const summary = await summarizeMessages(deps, { sessionId, system, toolDefs, input, target });
    const framed = compaction.checkpointMessage(summary);
    const tokensAfter = compaction.estimateMessageTokens(framed);
    if (tokensAfter >= tokensBefore) {
      throw new Error("summary is not smaller than the shadowed content (" + tokensAfter + " >= " + tokensBefore + ")");
    }
    const content = await deps.store.run("content.add", { content: summary });
    await deps.store.run("compaction.succeed", {
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
      await deps.store.run("compaction.fail", { id: record.id, error: message });
    } catch (failError) {
      console.warn("[compaction] marking the compaction row failed:", (failError && failError.message) || failError);
    }
    onEvent({ type: "compaction", phase: "failed", trigger, error: message });
    return { ok: false, error: message };
  }
}

// Manual /compact: idle session only, DSH's retainTokens=0 -> keep the last
// balanced surface unit and compact everything before it.
async function compactSession(deps, { sessionId, model, onEvent = () => {} } = {}) {
  if (!deps.store) return { ok: false, error: "storage not initialized" };
  if (!sessionId) return { ok: false, error: "compact requires a session" };
  if (deps.activeSessions.has(String(sessionId))) {
    return { ok: false, error: "compact requires an idle session: a turn is running" };
  }
  const key = String(sessionId);
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  deps.compacting.set(key, gate);
  try {
    const active = await deps.store.run("compaction.active", { session_id: sessionId, boot: deps.bootId });
    if (active) return { ok: false, error: "compaction already in progress" };
    const surface = await surfaceNodes(deps, sessionId);
    const boundary = compaction.selectTailBoundary(ownNodes(sessionId, surface));
    if (!boundary) return { ok: false, error: "no compactable history yet" };
    const st = deps.config.readSettings();
    const target = deps.config.resolveTarget({ model, settings: st });
    const system = await deps.store.run("session.prompt", { session_id: sessionId });
    const toolDefs = deps.tools.defs(deps.tools.select());
    return await runCompaction(deps, {
      sessionId,
      trigger: "manual",
      surface,
      boundary,
      system,
      toolDefs,
      target,
      onEvent,
    });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    deps.compacting.delete(key);
    releaseGate();
  }
}

// Automatic policy before one model request: prune first, then summarize when
// still above the pressure threshold (or after a context-overflow rejection).
async function maybeCompactStep(deps, { sessionId, conv, system, toolDefs, model, trigger = "pressure", pending, onEvent = () => {} }) {
  if (!deps.store || !sessionId) return { conv, changed: false };
  const st = deps.config.readSettings();
  if (st.autoCompact === false) return { conv, changed: false };
  const window = deps.config.resolveContextWindow({ provider: st.provider, model, settings: st });
  const thresholdTokens = Math.floor(window * compaction.AUTO_THRESHOLD_RATIO);
  const isOverflow = trigger === "context-overflow";
  const pendingMessages = pending ? pending() : [];
  const anchor = await deps.store.run("tokenAnchor.get", { session_id: sessionId });
  let measurement = tokenMeter.measure({
    messages: conv.slice(1),
    system,
    tools: toolDefs,
    model,
    anchor,
  });
  if (!isOverflow && measurement.total < thresholdTokens) return { conv, changed: false };

  const active = await deps.store.run("compaction.active", { session_id: sessionId, boot: deps.bootId });
  if (active) {
    console.warn("[compaction] another compaction holds the lock; skipping automatic pass");
    return { conv, changed: false };
  }
  let current = conv;
  let changed = false;

  // Phase 1: model-free tool-result pruning.
  try {
    const pruned = await pruneToolResults(deps, sessionId);
    if (pruned.count > 0) {
      current = await requestMessages(deps, sessionId, system, pendingMessages);
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
  const surface = await surfaceNodes(deps, sessionId);
  const own = ownNodes(sessionId, surface);
  const boundary = isOverflow
    ? compaction.selectTailBoundary(own)
    : compaction.selectAutoBoundary(
      own,
      Math.floor(window * compaction.AUTO_RETAIN_RATIO),
      compaction.estimateMessagesTokens(pendingMessages),
    );
  if (!boundary) return { conv: current, changed };

  const target = deps.config.resolveTarget({ model, settings: st });
  const result = await runCompaction(deps, {
    sessionId,
    trigger,
    surface,
    boundary,
    system,
    toolDefs,
    target,
    onEvent,
  });
  if (result.ok) {
    current = await requestMessages(deps, sessionId, system, pendingMessages);
    changed = true;
    measurement = tokenMeter.measure({ messages: current.slice(1), system, tools: toolDefs, model, anchor });
    if (!isOverflow && measurement.total >= thresholdTokens) {
      console.warn("[compaction] still above the pressure threshold after one compaction pass (retained tail is over budget)");
    }
  }
  return { conv: current, changed };
}

module.exports = {
  surfaceNodes,
  requestMessages,
  summarizeMessages,
  pruneToolResults,
  runCompaction,
  compactSession,
  maybeCompactStep,
};
