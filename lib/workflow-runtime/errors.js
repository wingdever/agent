"use strict";

// Workflow run vocabulary: identity block, terminal result, error codes and the
// fatal error type shared by the runtime, the core run and the model-facing
// tool. Plain data and pure functions only — no session, storage or host API.

/**
 * Machine-routable workflow failures. Fatal codes end the whole run; an
 * ordinary child failure resolves its item to null instead and is not a code.
 */
const ERROR_CODES = Object.freeze([
  "SCRIPT_PARSE",
  "META_INVALID",
  "INVALID_ARGUMENT",
  "UNSUPPORTED_OPTION",
  "UNSUPPORTED_SCHEMA",
  "AGENT_CAP",
  "ITEM_CAP",
  "AGENT_START",
  "AGENT_RESULT",
  "RESULT_UNSERIALIZABLE",
  "CANCELLED",
  "RUN_FAILED",
]);

const ERROR_CODE_SET = new Set(ERROR_CODES);

// Fatal errors cross a vm realm boundary, where `instanceof` against the host
// class does not hold for objects the script could fabricate. The host marks
// its own errors with a private symbol; combinators recognise fatality by that
// symbol and by the `fatal` property so a script cannot forge or dissolve it.
const FATAL = Symbol.for("deepseek-agent.workflow.fatal");

class WorkflowError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = ERROR_CODE_SET.has(code) ? code : "RUN_FAILED";
    this.fatal = options.fatal !== false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

for (const error of [WorkflowError]) {
  Object.defineProperty(error.prototype, FATAL, { value: true, enumerable: false });
}

/**
 * Whether combinators must re-throw `error` instead of mapping the item to null.
 * @param {unknown} error
 * @returns {boolean}
 */
function isFatalWorkflowError(error) {
  if (error instanceof WorkflowError) return error.fatal === true;
  return !!(error && typeof error === "object" && error[FATAL] === true && error.fatal === true);
}

/** Why a run settled. Closed union. */
const STOP_REASONS = Object.freeze(["completed", "cancelled", "error"]);

/**
 * Build a terminal result. `value` is the script's materialized return value;
 * non-completed reasons carry `error` and never mean partial output.
 * @param {object} fields
 */
function workflowResult({ value = null, stopReason, error, errorCode, agentsStarted } = {}) {
  const result = {
    value: value === undefined ? null : value,
    stopReason: STOP_REASONS.includes(stopReason) ? stopReason : "error",
    agentsStarted: Number.isInteger(agentsStarted) && agentsStarted >= 0 ? agentsStarted : 0,
  };
  if (result.stopReason !== "completed") {
    result.error = error != null ? String(error) : "workflow run ended abnormally";
    if (errorCode && ERROR_CODE_SET.has(errorCode)) result.errorCode = errorCode;
  }
  return result;
}

/** The outcome face of a result, without the value, for event payloads. */
function resultInfo(result) {
  const info = { stopReason: result.stopReason, agentsStarted: result.agentsStarted };
  if (result.error !== undefined) info.error = result.error;
  if (result.errorCode !== undefined) info.errorCode = result.errorCode;
  return info;
}

const __exports = {
  ERROR_CODES,
  ERROR_CODE_SET,
  STOP_REASONS,
  WorkflowError,
  isFatalWorkflowError,
  workflowResult,
  resultInfo,
};
export { ERROR_CODES, ERROR_CODE_SET, STOP_REASONS, WorkflowError, isFatalWorkflowError, workflowResult, resultInfo };
export default __exports;
