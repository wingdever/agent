"use strict";

// Shared Team task board: read one task including readiness diagnostics.

export default {
  async run(args = {}, exec = {}) {
    if (!exec.team) return { text: "Error: the Team task board is unavailable in this context", isError: true };
    const task = await exec.team.getTask(exec.sessionId, args.task_id);
    return { text: JSON.stringify(task), meta: { task_id: task.id, revision: task.revision, status: task.status } };
  },
};
