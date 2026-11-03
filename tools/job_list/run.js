"use strict";

// List user jobs for the current session. No side effects.

module.exports = {
  async run(args = {}, exec = {}) {
    const store = exec.store;
    if (!store) return { text: "Error: job tools require an active session", isError: true };
    const jobs = await store.run("userJob.list", { session_id: exec.sessionId });
    if (!jobs || !jobs.length) return { text: "No user jobs in this session yet." };
    const lines = jobs.map((j) => {
      const desc = String(j.description || "").replace(/\s+/g, " ");
      const snippet = desc.length > 80 ? desc.slice(0, 80) + "…" : desc;
      return "- " + j.jobId + " [" + j.status + "] " + snippet;
    });
    return {
      text: "User jobs (" + jobs.length + "):\n" + lines.join("\n"),
      meta: { count: jobs.length },
    };
  },
};
