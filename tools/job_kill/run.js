"use strict";

// Cancel a pending user job. If the job is still awaiting the user, this also
// resolves its pending request_user_job call so the turn can finish; otherwise
// (completed / already killed) it only reports the status.

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
        text: "Job " + job.jobId + " is already completed; it cannot be killed.",
        meta: { job_id: job.jobId, status: "completed" },
      };
    }
    if (job.status === "killed") {
      return {
        text: "Job " + job.jobId + " was already cancelled.",
        meta: { job_id: job.jobId, status: "killed" },
      };
    }
    // pending -> cancel. Resolve any outstanding request_user_job suspension.
    if (typeof exec.killUserJob === "function") {
      await exec.killUserJob(jobId);
    }
    await store.run("userJob.kill", { job_id: jobId });
    return { text: "Job " + jobId + " cancelled.", meta: { job_id: jobId, status: "killed" } };
  },
};
