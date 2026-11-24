"use strict";

// RequestSpec: the single owner of one model request's fields.
// Public fields keep plain-object compatibility with test mocks; the two
// methods maintain the cross-field invariants documented in schema.md.
class RequestSpec {
  constructor(opts = {}) {
    this.header = opts.header != null ? opts.header : null;
    this.messages = opts.messages != null ? opts.messages : null;
    this.planActive = opts.planActive === true;
    this.model = opts.model != null ? opts.model : null;
    this.baseUrl = opts.baseUrl != null ? opts.baseUrl : null;
    this.apiKey = opts.apiKey != null ? opts.apiKey : null;
    this.effort = opts.effort != null ? opts.effort : null;
    // undefined is meaningful: resolve-target uses it to fall back to settings.
    this.stream = opts.stream !== undefined ? !!opts.stream : undefined;
    this.selected = opts.selected != null ? opts.selected : [];
    this.toolDefs = opts.toolDefs != null ? opts.toolDefs : [];
    this.permissions = opts.permissions != null ? opts.permissions : null;
    this.fsPolicy = opts.fsPolicy != null ? opts.fsPolicy : null;
    this.sessionId = opts.sessionId;
    this.onEvent = opts.onEvent != null ? opts.onEvent : () => {};
  }

  // header and messages[0].content are two views of the same system text.
  setHeader(header) {
    this.header = header;
    if (Array.isArray(this.messages) && this.messages.length) {
      this.messages[0].content = header;
    }
    return header;
  }

  appendMessage(message) {
    this.messages.push(message);
    return message;
  }
}

const __exports = { RequestSpec };
export { RequestSpec };
export default __exports;
