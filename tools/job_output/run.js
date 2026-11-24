"use strict";

// Read a background job's result/status. Agent jobs (`job_...`) live in jobs;
// user jobs (`ujob_...`) remain in user_jobs for backward compatibility.

function isAgentJobId(jobId) {
  return jobId.startsWith("job_");
}

function renderAgentJob(job) {
  const head = "Job " + job.jobId + " [" + job.status + "]" + (job.label ? " " + job.label : "");
  if (job.status === "running") {
    return head + " is still running." + (job.output ? "\n\nRecent output:\n" + job.output : "");
  }
  if (job.status === "failed") {
    return head + " failed: " + (job.detail || "unknown error") + (job.output ? "\n\nRecent output:\n" + job.output : "");
  }
  if (job.status === "killed") {
    return head + " was cancelled" + (job.detail ? " (" + job.detail + ")" : "") + ".";
  }
  return head + (job.detail ? " (" + job.detail + ")" : "") +
    ".\n\nResult:\n" + (job.result || "(no result)") +
    (job.output ? "\n\nRecent output:\n" + job.output : "");
}

function renderUserJob(job) {
  if (job.status === "completed") {
    return "Job " + job.jobId + " completed.\n\nUser report:\n" + (job.result || "(no report provided)");
  }
  if (job.status === "killed") return "Job " + job.jobId + " was cancelled (no result).";
  return "Job " + job.jobId + " is still pending — the user has not reported back yet.";
}

export default {
  async run(args = {}, exec = {}) {
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (!jobId) return { text: "Error: job_id is required", isError: true };
    const store = exec.store;
    if (!store) return { text: "Error: job tools require an active session", isError: true };

    if (exec.jobs && isAgentJobId(jobId)) {
      const job = await exec.jobs.get(jobId);
      if (!job) return { text: "Error: no background job found with job_id " + jobId, isError: true };
      return {
        text: renderAgentJob(job),
        meta: { job_id: job.jobId, kind: job.kind, status: job.status },
      };
    }

    const job = await store.run("userJob.get", { job_id: jobId });
    if (!job) return { text: "Error: no user job found with job_id " + jobId, isError: true };
    return {
      text: renderUserJob(job),
      meta: { job_id: job.jobId, status: job.status },
    };
  },
};
