"use strict";

// create_goal: create (and arm) the session goal from a user request.
// Result shape and the shared implementation live in tools/goal/shared.js
// (docs/agents/goal.md §3-§4); GoalService owns phase/CAS checks.

import { createGoal } from "../goal/shared.js";

export default {
  async run(args = {}, exec = {}) {
    return createGoal(args, exec);
  },
};
