"use strict";

module.exports = {
  async run(args = {}, exec = {}) {
    if (!exec.goals) throw new Error("get_goal is not available in this context");
    const value = await exec.goals.get(exec.sessionId);
    return { text: JSON.stringify(value), meta: value };
  },
};
