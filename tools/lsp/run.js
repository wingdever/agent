"use strict";

// The model-facing LSP tool. It validates the four-field contract, delegates
// provider selection and protocol work to LspService, and turns normalized
// results into the text channel the rest of the tools use.

import { formatLspResult } from "./format.js";

const OPERATIONS = new Set([
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "hover",
]);

function errorResult(code, message, meta) {
  return {
    text: `Error: ${code ? code + ": " : ""}${message}`,
    isError: true,
    meta: { ...(meta || {}), code: code || "LSP_ERROR" },
  };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

export async function run(args, exec) {
  const input = args && typeof args === "object" ? args : {};
  const operation = input.operation;
  const filePath = input.file_path;
  const line = input.line;
  const character = input.character;

  if (!OPERATIONS.has(operation)) {
    return errorResult("LSP_INVALID_ARGUMENT", "operation must be goToDefinition, findReferences, goToImplementation, or hover");
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
    return errorResult("LSP_INVALID_ARGUMENT", "file_path must be a non-empty string");
  }
  if (!positiveInteger(line)) {
    return errorResult("LSP_INVALID_ARGUMENT", "line must be a one-based positive integer");
  }
  if (!positiveInteger(character)) {
    return errorResult("LSP_INVALID_ARGUMENT", "character must be a one-based positive integer");
  }

  const lsp = exec && exec.lsp;
  if (!lsp || typeof lsp.query !== "function") {
    return errorResult("LSP_UNAVAILABLE", "no LSP service is available");
  }

  const meta = { operation, filePath, line, character };
  try {
    const result = await lsp.query({
      operation,
      filePath,
      line,
      character,
      cwd: exec.cwd,
      signal: exec.signal,
    });
    return {
      text: formatLspResult(result, { operation, filePath, line, character, cwd: exec.cwd }),
      meta: {
        ...meta,
        server: result.server || null,
        count: operation === "hover" ? (result.hover && result.hover.text ? 1 : 0) : (result.locations || []).length,
      },
    };
  } catch (error) {
    const code = error && typeof error.code === "string" ? error.code : "LSP_REQUEST_FAILED";
    return errorResult(code, error && error.message ? error.message : String(error), meta);
  }
}

const __exports = { run };
export default __exports;
