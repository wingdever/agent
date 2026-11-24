"use strict";

// Shared Team task board: paged list with status/owner/readiness filters.

export default {
  async run(args = {}, exec = {}) {
    if (!exec.team) return { text: "Error: the Team task board is unavailable in this context", isError: true };
    const page = await exec.team.listTasks(exec.sessionId, {
      status: args.status,
      owner: args.owner,
      unowned: args.unowned,
      ready: args.ready,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      text: JSON.stringify(page),
      meta: { count: page.tasks.length, nextCursor: page.nextCursor },
    };
  },
};
