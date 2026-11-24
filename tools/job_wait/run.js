"use strict";

// Wait for an agent background job to settle, bounded by timeout_ms. This is
// the only synchronous read path for a running job; job_output never blocks.

function head(job) {
  return "Job " + job.jobId + " [" + job.status + "]" + (job.label ? " " + job.label : "");
}

function render(job) {
  if (job.status === "running") {
    return head(job) + " is still running after the wait." +
      (job.output ? "\n\nRecent output:\n" + job.output : "");
  }
  if (job.status === "failed") {
    return head(job) + " failed: " + (job.detail || "unknown error") +
      (job.output ? "\n\nRecent output:\n" + job.output : "");
  }
  if (job.status === "killed") {
    return head(job) + " was cancelled" + (job.detail ? " (" + job.detail + ")" : "") + ".";
  }
  return head(job) + (job.detail ? " (" + job.detail + ")" : "") +
    ".\n\nResult:\n" + (job.result || "(no result)") +
    (job.output ? "\n\nRecent output:\n" + job.output : "");
}

export default {
  async run(args = {}, exec = {}) {
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (!jobId) return { text: "Error: job_id is required", isError: true };
    if (!exec.jobs || typeof exec.jobs.wait !== "function") {
      return { text: "Error: job_wait requires the background job service", isError: true };
    }
    const timeout = Number.isInteger(args.timeout_ms) ? args.timeout_ms : 10000;
    const job = await exec.jobs.wait(jobId, timeout);
    if (!job) return { text: "Error: no background job found with job_id " + jobId, isError: true };
    return { text: render(job), meta: { job_id: job.jobId, status: job.status } };
  },
};
