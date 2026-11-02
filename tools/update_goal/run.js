"use strict";

module.exports = {
  async run(args = {}, exec = {}) {
    if (!exec.goals) throw new Error("update_goal is not available in this context");
    const value = await exec.goals.update(exec.sessionId, args);
    return { text: JSON.stringify(value), meta: value };
  },
};
