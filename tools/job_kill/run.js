"use strict";

// Cancel a job. Agent jobs stop their live run; pending user jobs also resolve
// their suspended request_user_job call so the turn can finish. Terminal jobs
// only report their current status.

function isAgentJobId(jobId) {
  return jobId.startsWith("job_");
}

export default {
  async run(args = {}, exec = {}) {
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (!jobId) return { text: "Error: job_id is required", isError: true };
    const store = exec.store;
    if (!store) return { text: "Error: job tools require an active session", isError: true };

    if (exec.jobs && isAgentJobId(jobId)) {
      const job = await exec.jobs.kill(jobId);
      if (!job) return { text: "Error: no background job found with job_id " + jobId, isError: true };
      if (job.status !== "killed") {
        return {
          text: "Job " + job.jobId + " is already " + job.status + "; it cannot be killed.",
          meta: { job_id: job.jobId, status: job.status },
        };
      }
      return { text: "Job " + job.jobId + " cancelled.", meta: { job_id: job.jobId, status: "killed" } };
    }

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
    if (typeof exec.killUserJob === "function") {
      await exec.killUserJob(jobId);
    }
    await store.run("userJob.kill", { job_id: jobId });
    return { text: "Job " + jobId + " cancelled.", meta: { job_id: jobId, status: "killed" } };
  },
};
