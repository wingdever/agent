"use strict";

// ModelResponse: normalized output of response-process.finalize().
// Fields only — consumers must not rely on instanceof or methods, because
// tests mock model.stream with plain objects of the same shape.
class ModelResponse {
  constructor(opts = {}) {
    this.role = opts.role != null ? opts.role : "assistant";
    this.content = opts.content != null ? opts.content : "";
    this.reasoning_content = opts.reasoning_content != null ? opts.reasoning_content : "";
    this.tool_calls = opts.tool_calls;
    this.finish_reason = opts.finish_reason != null ? opts.finish_reason : null;
    this.usage = opts.usage != null ? opts.usage : null;
  }
}

const __exports = { ModelResponse };
export { ModelResponse };
export default __exports;
