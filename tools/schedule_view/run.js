"use strict";

export default {
  async run(args = {}, exec = {}) {
    if (!exec.schedule) return { text: "Error: scheduled tasks are unavailable in this context", isError: true };
    const task = await exec.schedule.view(exec.sessionId, args.id);
    return { text: JSON.stringify(task), meta: { schedule_id: task.id, revision: task.revision, status: task.status } };
  },
};
