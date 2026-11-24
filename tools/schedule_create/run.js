"use strict";

// Schedule tool: create one persisted Host-level rule. The service validates
// the timing, resolves target identity and arms the next occurrence timer.

export default {
  async run(args = {}, exec = {}) {
    if (!exec.schedule) return { text: "Error: scheduled tasks are unavailable in this context", isError: true };
    const task = await exec.schedule.create(exec.sessionId, {
      title: args.title,
      prompt: args.prompt,
      timing: args.timing,
      target: args.target,
    });
    return {
      text: JSON.stringify({
        id: task.scheduleId,
        revision: task.revision,
        title: task.title,
        status: task.status,
        nextAt: task.nextAt,
        target: task.target,
      }),
      meta: { schedule_id: task.scheduleId, revision: task.revision, next_at: task.nextAt },
    };
  },
};
