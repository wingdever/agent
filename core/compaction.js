"use strict";

// Context compaction primitives, ported from DeepSeek Harness
// (packages/compaction/*). The semantics follow DSH:
//   - older history is replaced by ONE model-written checkpoint message,
//     recent history is retained verbatim, and the original log is never
//     rewritten (the projection happens at request-assembly time);
//   - manual /compact retains the last complete turn, automatic pressure
//     compaction retains roughly 16% of the context window, and
//     context-overflow recovery compacts everything older than the live turn;
//   - oversized tool results are pruned head/middle/tail before summarizing;
//   - a summary that is not smaller than the span it replaces fails closed.
//
// This module is pure: token estimation, range selection, pruning, framing,
// and the DSH summarization prompt. The model call and persistence live in
// core/index.js.

const DEFAULT_CONTEXT_WINDOW = 128000;
const AUTO_THRESHOLD_RATIO = 0.8;
const AUTO_RETAIN_RATIO = 0.16;
// Manual /compact keeps the newest complete turn verbatim (DSH's manual path
// uses retainTokens=0, which keeps the last balanced surface unit).
const MANUAL_RETAIN_TURNS = 1;
const SUMMARY_MAX_TOKENS = 8192;

// DSH token-meter heuristic: 4 characters per token plus fixed JSON framing.
const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const BLOCK_OVERHEAD = 4;

// DSH compaction-tool-result-pruner defaults.
const PRUNE_THRESHOLD_CHARS = 8192;
const PRUNE_HEAD_CHARS = 4096;
const PRUNE_TAIL_CHARS = 1024;
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";

// The checkpoint is delivered as a user message so the model treats it as
// established context (DSH frames the same way).
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. " +
  "Treat the captured context as established background and build on it without restating it. " +
  "Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

// DSH's summarization directive, delivered as the final user message after the
// replayed conversation. Kept verbatim (English engineering prose) so a
// checkpoint from this harness is structurally interchangeable with DSH's.
const COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
  "",
  "## Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
  "",
  "Rules:",
  "- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and explicit instructions faithfully, especially corrections.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action.",
  "- If the conversation already contains a " + SUMMARY_OPEN_TAG + " block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.",
].join("\n");

function estimateTextTokens(text) {
  if (text == null) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

// Mirrors DSH's estimateContent/estimateMessage: per-block structural overhead
// plus message role framing. Only the shapes this harness produces are priced.
function estimateBlockTokens(block) {
  if (block == null) return 0;
  if (typeof block === "string") return estimateTextTokens(block) + BLOCK_OVERHEAD;
  if (block.type === "text" || block.type === "reasoning") {
    return estimateTextTokens(block.text) + BLOCK_OVERHEAD;
  }
  return estimateTextTokens(JSON.stringify(block)) + BLOCK_OVERHEAD;
}

function estimateMessageTokens(message) {
  if (!message) return 0;
  let tokens = MESSAGE_OVERHEAD;
  const content = message.content;
  if (typeof content === "string") {
    tokens += estimateTextTokens(content) + BLOCK_OVERHEAD;
  } else if (Array.isArray(content)) {
    for (const block of content) tokens += estimateBlockTokens(block);
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = (call && call.function) || {};
      tokens += estimateTextTokens(fn.name) + estimateTextTokens(fn.arguments) + BLOCK_OVERHEAD;
    }
  }
  return tokens;
}

function estimateMessagesTokens(messages) {
  let tokens = 0;
  for (const message of messages || []) tokens += estimateMessageTokens(message);
  return tokens;
}

// Tool schemas ride in every request; the pressure check must price them the
// way DSH's request-image meter does.
function estimateToolsTokens(toolDefs) {
  let tokens = 0;
  for (const tool of toolDefs || []) {
    tokens += Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN);
  }
  return tokens;
}

function codePointLength(text) {
  return Array.from(String(text == null ? "" : text)).length;
}

// Deterministic head/middle/tail pruning of one oversized tool result. Returns
// null when the text fits the budget (DSH: no replacement is written).
function pruneToolResultText(text, options = {}) {
  const thresholdChars = options.thresholdChars == null ? PRUNE_THRESHOLD_CHARS : options.thresholdChars;
  const headChars = options.headChars == null ? PRUNE_HEAD_CHARS : options.headChars;
  const tailChars = options.tailChars == null ? PRUNE_TAIL_CHARS : options.tailChars;
  const points = Array.from(String(text == null ? "" : text));
  const charsBefore = points.length;
  if (charsBefore <= thresholdChars) return null;
  const head = points.slice(0, headChars).join("");
  const tailStart = Math.max(headChars, charsBefore - tailChars);
  const tail = points.slice(tailStart).join("");
  const content = head + PRUNE_MARKER + tail;
  return { content, charsBefore, charsAfter: codePointLength(content) };
}

function frameCheckpoint(summary) {
  const body = String(summary == null ? "" : summary).trim();
  return CHECKPOINT_PREAMBLE + "\n\n" + SUMMARY_OPEN_TAG + "\n" + body + "\n" + SUMMARY_CLOSE_TAG;
}

function checkpointMessage(summary) {
  return { role: "user", content: frameCheckpoint(summary) };
}

// DSH error classification: recognize provider wording for a context-window
// rejection through the same pattern family used by dsh-llm.
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  "i",
);
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  "i",
);
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  "i",
);

function isContextOverflowError(text) {
  const detail = String(text == null ? "" : text);
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail);
}

// Tool-pair balance over the message-level surface: a cut is safe when no
// assistant tool call is still waiting for its result. cut[i] describes the cut
// BEFORE node i; the final entry is the cut after the surface tail.
function surfaceCuts(nodes) {
  const cuts = new Array((nodes || []).length + 1).fill(false);
  cuts[0] = true;
  let pendingCalls = 0;
  for (let index = 0; index < (nodes || []).length; index += 1) {
    const node = nodes[index];
    if (node.role === "assistant" && Array.isArray(node.tool_calls)) {
      pendingCalls += node.tool_calls.length;
    } else if (node.role === "tool") {
      pendingCalls -= 1;
    }
    if (pendingCalls < 0) {
      throw new Error("compaction: a tool result has no matching tool call on the surface");
    }
    cuts[index + 1] = pendingCalls === 0;
  }
  return cuts;
}

// DSH's selectCompactableRange over a message-level surface: retain the tail
// worth at least retainTokens, cut on the nearest balanced position, and return
// the last compacted node. `extraTailTokens` covers a pending user message that
// has not been persisted yet (r=0 pre-step), so it is never compacted.
function selectAutoBoundary(nodes, retainTokens, extraTailTokens) {
  if (!nodes || nodes.length === 0) return null;
  const cuts = surfaceCuts(nodes);
  let accumulated = Math.max(0, extraTailTokens || 0);
  let keepFrom = nodes.length;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    keepFrom = index;
    accumulated += nodes[index].tokens || 0;
    if (accumulated >= retainTokens) break;
  }
  if (keepFrom === 0) return null;
  // Round the cut forward to a balanced tool-pair boundary.
  while (keepFrom > 0 && !cuts[keepFrom]) keepFrom -= 1;
  if (keepFrom === 0) return null;
  return nodes[keepFrom - 1];
}

// Manual /compact and context-overflow both use retainTokens=0 in DSH: keep the
// last balanced surface unit and compact everything before it.
function selectTailBoundary(nodes) {
  return selectAutoBoundary(nodes, 0, 0);
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  AUTO_THRESHOLD_RATIO,
  AUTO_RETAIN_RATIO,
  MANUAL_RETAIN_TURNS,
  SUMMARY_MAX_TOKENS,
  PRUNE_THRESHOLD_CHARS,
  PRUNE_HEAD_CHARS,
  PRUNE_TAIL_CHARS,
  PRUNE_MARKER,
  SUMMARY_OPEN_TAG,
  SUMMARY_CLOSE_TAG,
  CHECKPOINT_PREAMBLE,
  COMPACTION_INSTRUCTION,
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
  codePointLength,
  pruneToolResultText,
  frameCheckpoint,
  checkpointMessage,
  isContextOverflowError,
  surfaceCuts,
  selectAutoBoundary,
  selectTailBoundary,
};
