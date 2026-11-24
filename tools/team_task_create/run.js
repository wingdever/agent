"use strict";

// Shared Team task board: create one unowned pending task. The service owns
// board identity, dependencies, maxTasks, and the task view.

export default {
  async run(args = {}, exec = {}) {
    if (!exec.team) return { text: "Error: the Team task board is unavailable in this context", isError: true };
    const task = await exec.team.createTask(exec.sessionId, {
      subject: args.subject,
      description: args.description,
      blockedBy: args.blocked_by,
      writeScopes: args.write_scopes,
    });
    return { text: JSON.stringify(task), meta: { task_id: task.id, revision: task.revision, status: task.status } };
  },
};
