"use strict";

// Workflow script mechanism: meta validation, script compilation and execution,
// the six hooks, cooperative caps and lossless-JSON materialization. Subagents
// arrive through an injected childPort, so this module never touches a session,
// the store or the agent loop (arch.md: mechanism in lib, policy in core).

import { WorkflowError, isFatalWorkflowError, workflowResult, resultInfo, ERROR_CODES } from "./errors.js";
import { validateMeta } from "./meta.js";
import { assertObjectJsonSchema, parseStructured } from "./schema.js";
import { materializeJson, MaterializeError, renderThrown } from "./realm.js";
import { WorkflowExecution, DEFAULT_LIMITS, compileScript } from "./execution.js";

const __exports = {
  WorkflowError,
  isFatalWorkflowError,
  workflowResult,
  resultInfo,
  ERROR_CODES,
  validateMeta,
  assertObjectJsonSchema,
  parseStructured,
  materializeJson,
  MaterializeError,
  renderThrown,
  WorkflowExecution,
  DEFAULT_LIMITS,
  compileScript,
};
export { WorkflowError, isFatalWorkflowError, workflowResult, resultInfo, ERROR_CODES, validateMeta, assertObjectJsonSchema, parseStructured, materializeJson, MaterializeError, renderThrown, WorkflowExecution, DEFAULT_LIMITS, compileScript };
export default __exports;
