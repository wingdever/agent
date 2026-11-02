"use strict";

// create_goal: persist the session's current goal. The round driver is not
// implemented yet; the goal value is still durable and revision-checked.

module.exports = {
  async run(args = {}, exec = {}) {
    if (!exec.goals) throw new Error("create_goal is not available in this context");
    const value = await exec.goals.create(exec.sessionId, args);
    return { text: JSON.stringify(value), meta: value };
  },
};
