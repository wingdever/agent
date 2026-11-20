"use strict";

// Workflow script mechanism: meta validation, script compilation and execution,
// the six hooks, cooperative caps and lossless-JSON materialization. Subagents
// arrive through an injected childPort, so this module never touches a session,
// the store or the agent loop (arch.md: mechanism in lib, policy in core).

const {
  WorkflowError,
  isFatalWorkflowError,
  workflowResult,
  resultInfo,
  ERROR_CODES,
} = require("./errors");
const { validateMeta } = require("./meta");
const { assertObjectJsonSchema, parseStructured } = require("./schema");
const { materializeJson, MaterializeError, renderThrown } = require("./realm");
const { WorkflowExecution, DEFAULT_LIMITS, compileScript } = require("./execution");

module.exports = {
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
