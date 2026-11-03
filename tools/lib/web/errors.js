"use strict";

// Errors raised by the web tools that already carry their final model-facing
// message. transport.js rethrows these verbatim instead of wrapping them in a
// generic "web fetch failed: ..." prefix.

class WebToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebToolError";
  }
}

module.exports = { WebToolError };
