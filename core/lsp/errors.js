"use strict";

// Typed failures shared by the LSP service, server connection and tool layer.
// The code is stable enough to appear in the model-visible error prefix and in
// tool meta; the message only adds the concrete file/server detail.

class LspError extends Error {
  constructor(code, message, cause) {
    super(message || code);
    this.name = "LspError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function lspError(code, message, cause) {
  return new LspError(code, message, cause);
}

const __exports = { LspError, lspError };
export { LspError, lspError };
export default __exports;
