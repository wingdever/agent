"use strict";

// One tool call: validate arguments, run the tool body, and normalize the
// outcome to model-facing text. Permission/approval stay in core/index.js
// because they need the session UI; this module only owns the tool contract.

const { validateSchema } = require("./schema");
const { errorResult, normalizeResult } = require("./result");

function validateToolArgs(tool, args) {
  return validateSchema(tool.parameters, args);
}

async function runTool(tool, args, exec) {
  let result;
  try {
    result = await tool.run(args || {}, exec || {});
  } catch (error) {
    return errorResult(error && error.message ? error.message : String(error));
  }
  return normalizeResult(result);
}

module.exports = { validateToolArgs, runTool };
