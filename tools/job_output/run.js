"use strict";

// Read a user job's result/status from the store. No side effects.

module.exports = {
  async run(args = {}, exec = {}) {
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (!jobId) return { text: "Error: job_id is required", isError: true };
    const store = exec.store;
    if (!store) return { text: "Error: job tools require an active session", isError: true };
    const job = await store.run("userJob.get", { job_id: jobId });
    if (!job) return { text: "Error: no user job found with job_id " + jobId, isError: true };
    if (job.status === "completed") {
      return {
        text: "Job " + job.jobId + " completed.\n\nUser report:\n" + (job.result || "(no report provided)"),
        meta: { job_id: job.jobId, status: "completed" },
      };
    }
    if (job.status === "killed") {
      return {
        text: "Job " + job.jobId + " was cancelled (no result).",
        meta: { job_id: job.jobId, status: "killed" },
      };
    }
    return {
      text: "Job " + job.jobId + " is still pending — the user has not reported back yet.",
      meta: { job_id: job.jobId, status: "pending" },
    };
  },
};
