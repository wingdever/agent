"use strict";

export default {
  async run(args = {}, exec = {}) {
    if (!exec.schedule) return { text: "Error: scheduled tasks are unavailable in this context", isError: true };
    const page = await exec.schedule.list(exec.sessionId, {
      active: args.active,
      limit: args.limit,
      offset: args.offset,
    });
    return { text: JSON.stringify(page), meta: { total: page.total, shown: page.shown } };
  },
};
