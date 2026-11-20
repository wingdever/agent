"use strict";

// Model-facing rendering for workflow results: the completion line, the JSON
// return value (clipped to a character budget), and the per-run metadata the
// UI reads. Failures go through the shared "Error: ..." channel.

const DEFAULT_RESULT_CHARS = 50000;

/**
 * Render a completed run for the model.
 * @param {string} name workflow meta name
 * @param {number} agentsStarted number of agent() calls accepted
 * @param {unknown} value the script's return value (plain JSON)
 * @param {number} maxChars result character ceiling
 * @returns {string}
 */
function renderCompletion(name, agentsStarted, value, maxChars = DEFAULT_RESULT_CHARS) {
  const rendered = JSON.stringify(value === undefined ? null : value, null, 2);
  const clipped = rendered.length > maxChars
    ? `${rendered.slice(0, maxChars)}\n… [truncated: ${rendered.length - maxChars} more characters]`
    : rendered;
  const count = `${agentsStarted} agent${agentsStarted === 1 ? "" : "s"}`;
  return `workflow "${name}" completed (${count}).\nReturn value:\n${clipped}`;
}

/** One progress line for the job observation record, or null for an event it does not render. */
function renderProgress(event) {
  if (!event) return null;
  switch (event.event) {
    case "phase": return `▸ ${event.title}`;
    case "log": return String(event.message);
    case "agent-start": return `agent #${event.agent.seq} ${event.agent.label} started`;
    case "agent-end": return `agent #${event.agent.seq} ${event.agent.outcome}`;
    default: return null;
  }
}

/**
 * Map a non-completed stop reason to the failure text, or undefined on success.
 * @param {object} result
 * @returns {string|undefined}
 */
function stopReasonError(result) {
  switch (result && result.stopReason) {
    case "completed":
      return undefined;
    case "cancelled":
      return `workflow run was cancelled${result.error !== undefined ? ` (${result.error})` : ""}`;
    case "error":
      return `workflow run failed: ${result.error !== undefined ? result.error : "unknown error"}`;
    default:
      return `workflow run ended abnormally (${String(result && result.stopReason)})`;
  }
}

/**
 * The tool call's UI/DB metadata. It never enters the model conversation.
 * @param {object} run live run handle (id, meta, info, members)
 * @param {object} result terminal result
 */
function resultMeta(run, result) {
  return {
    runId: run.id,
    name: run.meta.name,
    description: run.meta.description,
    stopReason: result.stopReason,
    agentsStarted: result.agentsStarted,
    engine: run.info && run.info.engine,
    members: Array.isArray(run.members) ? run.members : [],
  };
}

module.exports = { DEFAULT_RESULT_CHARS, renderCompletion, renderProgress, stopReasonError, resultMeta };
