"use strict";

// One tool call: validate arguments, run the tool body, and normalize the
// outcome to model-facing text. Permission/approval stay in core/index.js
// because they need the session UI; this module only owns the tool contract.

import { validateSchema } from "./schema.js";
import { errorResult, normalizeResult } from "./../../lib/tool-result/index.js";

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

const __exports = { validateToolArgs, runTool };
export { validateToolArgs, runTool };
export default __exports;
