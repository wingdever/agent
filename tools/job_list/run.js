"use strict";

// List both kinds of jobs for the current session: agent background jobs
// (`job_...`) and human-delegated user jobs (`ujob_...`).

function snippet(text, max = 80) {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

export default {
  async run(args = {}, exec = {}) {
    const store = exec.store;
    if (!store) return { text: "Error: job tools require an active session", isError: true };

    const sections = [];
    let count = 0;

    if (exec.jobs) {
      const agentJobs = await exec.jobs.list(exec.sessionId);
      if (agentJobs && agentJobs.length) {
        count += agentJobs.length;
        sections.push("Background jobs (" + agentJobs.length + "):\n" + agentJobs.map((j) => {
          const label = j.label || j.kind || "job";
          return "- " + j.jobId + " [" + j.status + "] " + snippet(label) +
            (j.detail ? " — " + snippet(j.detail, 60) : "");
        }).join("\n"));
      }
    }

    const userJobs = await store.run("userJob.list", { session_id: exec.sessionId });
    if (userJobs && userJobs.length) {
      count += userJobs.length;
      sections.push("User jobs (" + userJobs.length + "):\n" + userJobs.map((j) => {
        return "- " + j.jobId + " [" + j.status + "] " + snippet(j.description);
      }).join("\n"));
    }

    if (!count) return { text: "No jobs in this session yet.", meta: { count: 0 } };
    return { text: sections.join("\n\n"), meta: { count } };
  },
};
