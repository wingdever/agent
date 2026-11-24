"use strict";

export default {
  async run(args = {}, exec = {}) {
    if (!exec.schedule) return { text: "Error: scheduled tasks are unavailable in this context", isError: true };
    const result = await exec.schedule.edit(exec.sessionId, {
      id: args.id,
      action: args.action,
      expectedRevision: args.expected_revision,
      title: args.title,
      prompt: args.prompt,
      target: args.target,
      active: args.active,
      timing: args.timing,
    });
    if (result.ok === false) {
      return { text: JSON.stringify(result), isError: true, meta: { code: result.error.code, current_revision: result.currentRevision } };
    }
    return {
      text: JSON.stringify(result),
      meta: { schedule_id: result.id || result.task?.id, revision: result.revision || result.task?.revision, deleted: result.deleted === true },
    };
  },
};
