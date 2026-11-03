"use strict";

// Delegate a task to the human and block until they report back. Core owns the
// pending promise, the job record, and the interactive card; this body only
// validates input and shapes the model-facing text (DSH-style: the tool owns
// the text, core owns the suspension and persistence).

function validate(args) {
  if (!args || typeof args !== "object") {
    throw new Error("request_user_job requires an object argument");
  }
  const description = typeof args.description === "string" ? args.description.trim() : "";
  if (!description) throw new Error("description is required and must be a non-empty string");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  return { description, title };
}

module.exports = {
  async run(args = {}, exec = {}) {
    const { description, title } = validate(args);
    if (typeof exec.requestUserJob !== "function") {
      throw new Error("request_user_job is not available in this context");
    }
    const res = await exec.requestUserJob({ description, title });
    const jobId = res && res.jobId ? res.jobId : "unknown";
    if (res && res.cancelled) {
      return {
        text: "Job " + jobId + " was cancelled by the user.",
        meta: { job_id: jobId, status: "killed" },
      };
    }
    const report = res && typeof res.result === "string" ? res.result : "";
    return {
      text: "Job " + jobId + " completed.\n\nUser report:\n" + (report || "(no report provided)"),
      meta: { job_id: jobId, status: "completed" },
    };
  },
};
