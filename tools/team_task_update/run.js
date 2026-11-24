"use strict";

// Shared Team task board: compare-and-set one task transition. Authorization
// and revision checks live in TeamService, not in the adapter.

export default {
  async run(args = {}, exec = {}) {
    if (!exec.team) return { text: "Error: the Team task board is unavailable in this context", isError: true };
    const task = await exec.team.updateTask(exec.sessionId, {
      taskId: args.task_id,
      expectedRevision: args.expected_revision,
      action: args.action,
      subject: args.subject,
      description: args.description,
      blockedBy: args.blocked_by,
      writeScopes: args.write_scopes,
      owner: args.owner,
    });
    return { text: JSON.stringify(task), meta: { task_id: task.id, revision: task.revision, status: task.status } };
  },
};
