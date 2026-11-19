"use strict";

// StepState: in-memory state of one step. row is the persisted projection;
// the remaining fields are working data that never leaves the process.
class StepState {
  constructor(opts = {}) {
    this.row = opts.row != null ? opts.row : null;
    this.messageSeq = opts.messageSeq != null ? opts.messageSeq : 0;
    this.userPersisted = opts.userPersisted === true;
    this.response = opts.response != null ? opts.response : null;
    this.assistantMsg = opts.assistantMsg != null ? opts.assistantMsg : null;
    this.callIds = opts.callIds != null ? opts.callIds : [];
  }

  // system / catalog / user / notice / assistant / tool share one seq.
  nextSeq() {
    return this.messageSeq++;
  }
}

module.exports = { StepState };
