"use strict";

// One tool call: validate arguments, run the tool body, and normalize the
// outcome to model-facing text. Permission/approval stay in core/index.js
// because they need the session UI; this module only owns the tool contract.

import { validateSchema } from "./schema.js";
import { errorResult, normalizeResult } from "./../../lib/tool-result/index.js";

// Cancellation keeps the two model-facing texts apart, matching the DSH
// contract (docs/path/dsh/prototype/tools/README.md): a body that never started
// says so, and a body that ran still reports the abort.
const ABORTED_TEXT = "tool call aborted";
const ABORTED_BEFORE_DISPATCH_TEXT = "tool call aborted before dispatch";

function abortedResult(beforeDispatch) {
  return errorResult(beforeDispatch ? ABORTED_BEFORE_DISPATCH_TEXT : ABORTED_TEXT);
}

// The tool body is never abandoned: once started it runs to completion or
// throws, and only then does a cancellation supersede its outcome. That keeps a
// half-finished side effect from being reported as if it had never happened.
function cancelled(signal) {
  return Boolean(signal && signal.aborted);
}

function validateToolArgs(tool, args) {
  return validateSchema(tool.parameters, args);
}

// Context deferred by a tool during this call (e.g. the goal tools' closing
// instruction after a terminal goal update). Appended to the turn's request as
// one more user instruction before the next step, never persisted.
function createDeferContext(sink) {
  return (text) => {
    if (typeof text === "string" && text.trim() && Array.isArray(sink)) sink.push({ role: "user", content: text });
  };
}

async function runTool(tool, args, exec) {
  const options = exec || {};
  if (cancelled(options.signal)) return abortedResult(true);

  let result;
  try {
    result = await tool.run(args || {}, options);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    // A body that failed because the call was cancelled keeps the abort text
    // rather than surfacing the tool's own wording.
    if (cancelled(options.signal)) return abortedResult(false);
    return errorResult(message);
  }
  // A success that landed after cancellation is still a cancelled call.
  if (cancelled(options.signal)) return abortedResult(false);
  return normalizeResult(result);
}

const __exports = { validateToolArgs, runTool, createDeferContext, ABORTED_TEXT, ABORTED_BEFORE_DISPATCH_TEXT };
export { validateToolArgs, runTool, createDeferContext, ABORTED_TEXT, ABORTED_BEFORE_DISPATCH_TEXT };
export default __exports;
