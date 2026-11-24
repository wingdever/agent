"use strict";

// Interaction state machines: approvals, questions, plan reviews and user jobs.
// One instance serves every session. Sink (emit) and autonomy are read from the
// calling agent's turn, never stored here, so concurrent sessions cannot
// overwrite each other's delivery state. Pending maps are keyed by id; every
// entry remembers its session for cancellation and cleanup.
class InteractionService {
  constructor({ store = null } = {}) {
    this.store = store;
    this.pendingApprovals = new Map();
    this._approvalSeq = 0;
    this.pendingQuestions = new Map();
    this._questionSeq = 0;
    this.pendingPlanReviews = new Map();
    this._planReviewSeq = 0;
    this.pendingUserJobs = new Map();
    this._userJobSeq = 0;
    this.userJobs = new Map();
  }

  // Instances are registered by the runtime; answer paths that did not come
  // from a tool call look the session up here instead of holding a stale
  // reference to a turn-bound sink.
  setRegistry(registry) {
    this.registry = registry;
  }

  _agentFor(sessionId) {
    if (!this.registry || sessionId == null) return null;
    return this.registry.get(sessionId);
  }

  // The turn's event sink; autonomous subagents emit into the void.
  emitFor(agent) {
    return agent && agent.turn ? agent.turn.emit : () => {};
  }

  isAutonomous(agent) {
    return !!agent && agent.turn && agent.turn.autonomy === "autonomous";
  }

  requestApproval({ agent, callId, name, args, permission = "ask" }) {
    const emit = this.emitFor(agent);
    if (this.isAutonomous(agent)) {
      emit({ type: "approval-request", callId, name, arguments: args, permission, autoDenied: true });
      return Promise.resolve("deny");
    }
    return new Promise((resolve) => {
      const id = (this._approvalSeq = (this._approvalSeq || 0) + 1);
      this.pendingApprovals.set(id, { resolve, sessionId: agent ? agent.sessionId : null });
      emit({ type: "model-http-status", state: "on-wait" });
      emit({ type: "approval-request", id, callId, name, arguments: args, permission });
    });
  }

  approve(id, decision) {
    const key = Number(id);
    const pending = this.pendingApprovals.get(key);
    if (!pending) return false;
    this.pendingApprovals.delete(key);
    pending.resolve(decision);
    return true;
  }

  requestUserQuestion({ agent, callId, questions }) {
    const emit = this.emitFor(agent);
    const list = Array.isArray(questions) ? questions : [];
    if (this.isAutonomous(agent)) {
      const answers = list.map((q) => ({ id: q.id, selected: [] }));
      return Promise.resolve({ answers });
    }
    return new Promise((resolve) => {
      const id = (this._questionSeq = (this._questionSeq || 0) + 1);
      this.pendingQuestions.set(id, { resolve, questions: list, callId, sessionId: agent ? agent.sessionId : null });
      emit({ type: "model-http-status", state: "on-wait" });
      emit({ type: "ask-user-question", id, callId, name: "ask_user_question", questions: list });
    });
  }

  answerQuestions(id, rawAnswers) {
    const key = Number(id);
    const pending = this.pendingQuestions.get(key);
    if (!pending) return false;
    this.pendingQuestions.delete(key);
    const submitted = Array.isArray(rawAnswers) ? rawAnswers : [];
    const answers = pending.questions.map((question) => {
      const found = submitted.find((answer) => answer && answer.id === question.id) || {};
      const selected = Array.isArray(found.selected)
        ? found.selected.filter((value) => typeof value === "string")
        : [];
      const custom = typeof found.custom === "string" && found.custom.trim() ? found.custom : undefined;
      return { id: question.id, selected, ...(custom !== undefined ? { custom } : {}) };
    });
    pending.resolve({ answers });
    return true;
  }

  requestPlanReview({ agent, callId, plan, sessionId }) {
    const emit = this.emitFor(agent);
    return new Promise((resolve) => {
      const id = (this._planReviewSeq = (this._planReviewSeq || 0) + 1);
      this.pendingPlanReviews.set(id, { resolve, sessionId, agent });
      emit({ type: "model-http-status", state: "on-wait" });
      emit({
        type: "plan-review",
        id,
        callId,
        plan,
        title: firstHeading(plan) || "Plan",
      });
    });
  }

  answerPlanReview(id, payload = {}) {
    const key = Number(id);
    const pending = this.pendingPlanReviews.get(key);
    if (!pending) return false;
    this.pendingPlanReviews.delete(key);
    const approved = payload.approved === true;
    const feedback = typeof payload.feedback === "string" ? payload.feedback : "";
    if (approved) {
      const agent = pending.agent;
      if (agent) agent.requestPlanExit();
      this.emitFor(agent)({ type: "plan-mode", active: false });
    }
    pending.resolve({ approved, feedback });
    return true;
  }

  requestUserJob({ agent, callId, description, title, sessionId }) {
    const emit = this.emitFor(agent);
    if (this.isAutonomous(agent)) {
      const jobId = "ujob_" + Date.now().toString(36) + "_" + ((this._userJobSeq = (this._userJobSeq || 0) + 1)).toString(36);
      return Promise.resolve({ jobId, cancelled: true });
    }
    return new Promise((resolve) => {
      this._userJobSeq = (this._userJobSeq || 0) + 1;
      const jobId = "ujob_" + Date.now().toString(36) + "_" + this._userJobSeq.toString(36);
      const record = {
        jobId,
        sessionId: sessionId || null,
        status: "pending",
        description: description || "",
        title: title || "",
        result: null,
      };
      this.userJobs.set(jobId, record);
      if (this.store) {
        this.store
          .run("userJob.create", {
            job_id: jobId,
            session_id: sessionId || null,
            status: "pending",
            description: description || "",
            title: title || "",
          })
          .catch((e) => console.error("[core] userJob.create failed:", e.message));
      }
      this.pendingUserJobs.set(jobId, { resolve, sessionId: sessionId || null });
      emit({ type: "model-http-status", state: "on-wait" });
      emit({ type: "user-job-request", id: jobId, callId, description, title });
    });
  }

  answerUserJob(id, payload = {}) {
    const key = String(id);
    const pending = this.pendingUserJobs.get(key);
    const record = this.userJobs.get(key);
    if (!pending || !record) return false;
    this.pendingUserJobs.delete(key);
    const cancelled = payload.cancel === true;
    const result = typeof payload.result === "string" ? payload.result : "";
    record.status = cancelled ? "killed" : "completed";
    record.result = result;
    if (this.store) {
      this.store
        .run(cancelled ? "userJob.kill" : "userJob.complete", {
          job_id: key,
          result: cancelled ? undefined : result,
        })
        .catch((e) => console.error("[core] userJob update failed:", e.message));
    }
    const agent = this._agentFor(pending.sessionId);
    this.emitFor(agent)({ type: "user-job-update", id: key, status: record.status });
    pending.resolve({ jobId: key, cancelled, result });
    return true;
  }

  killUserJob(jobId) {
    const key = String(jobId);
    const record = this.userJobs.get(key);
    if (!record) return false;
    if (record.status === "pending") return this.answerUserJob(key, { cancel: true });
    if (this.store) this.store.run("userJob.kill", { job_id: key }).catch(() => {});
    record.status = "killed";
    return true;
  }
}

function firstHeading(plan) {
  for (const line of String(plan == null ? "" : plan).split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return "";
}

const __exports = { InteractionService };
export { InteractionService };
export default __exports;
