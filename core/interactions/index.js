"use strict";

const planMode = require("../plan-mode");

// Interaction state machines: approvals, questions, plan reviews and user jobs.
// The sink and autonomy are per turn; pending maps live on this instance.
class InteractionService {
  constructor({ store = null, emit = () => {}, autonomy = "supervised" } = {}) {
    this.store = store;
    this.emit = emit;
    this.autonomy = autonomy;
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

  beginTurn({ emit = () => {}, autonomy = "supervised" } = {}) {
    this.emit = emit;
    this.autonomy = autonomy === "autonomous" ? "autonomous" : "supervised";
  }

  isAutonomous() {
    return this.autonomy === "autonomous";
  }

  requestApproval({ callId, name, args, permission = "ask" }) {
    if (this.isAutonomous()) {
      this.emit({ type: "approval-request", callId, name, arguments: args, permission, autoDenied: true });
      return Promise.resolve("deny");
    }
    return new Promise((resolve) => {
      const id = (this._approvalSeq = (this._approvalSeq || 0) + 1);
      this.pendingApprovals.set(id, resolve);
      this.emit({ type: "model-http-status", state: "on-wait" });
      this.emit({ type: "approval-request", id, callId, name, arguments: args, permission });
    });
  }

  approve(id, decision) {
    const key = Number(id);
    const fn = this.pendingApprovals.get(key);
    if (!fn) return false;
    this.pendingApprovals.delete(key);
    fn(decision);
    return true;
  }

  requestUserQuestion({ callId, questions }) {
    const list = Array.isArray(questions) ? questions : [];
    if (this.isAutonomous()) {
      const answers = list.map((q) => ({ id: q.id, selected: [] }));
      return Promise.resolve({ answers });
    }
    return new Promise((resolve) => {
      const id = (this._questionSeq = (this._questionSeq || 0) + 1);
      this.pendingQuestions.set(id, { resolve, questions: list, callId });
      this.emit({ type: "model-http-status", state: "on-wait" });
      this.emit({ type: "ask-user-question", id, callId, name: "ask_user_question", questions: list });
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

  requestPlanReview({ callId, plan, sessionId }) {
    return new Promise((resolve) => {
      const id = (this._planReviewSeq = (this._planReviewSeq || 0) + 1);
      this.pendingPlanReviews.set(id, { resolve, sessionId });
      this.emit({ type: "model-http-status", state: "on-wait" });
      this.emit({
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
      planMode.requestExit(pending.sessionId);
      this.emit({ type: "plan-mode", active: false });
    }
    pending.resolve({ approved, feedback });
    return true;
  }

  requestUserJob({ callId, description, title, sessionId }) {
    if (this.isAutonomous()) {
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
      this.pendingUserJobs.set(jobId, resolve);
      this.emit({ type: "model-http-status", state: "on-wait" });
      this.emit({ type: "user-job-request", id: jobId, callId, description, title });
    });
  }

  answerUserJob(id, payload = {}) {
    const key = String(id);
    const resolve = this.pendingUserJobs.get(key);
    const record = this.userJobs.get(key);
    if (!resolve || !record) return false;
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
    this.emit({ type: "user-job-update", id: key, status: record.status });
    resolve({ jobId: key, cancelled, result });
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

module.exports = { InteractionService };
