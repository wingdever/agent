"use strict";

// update_goal: CAS edit / pause / resume / complete / blocked. GoalService
// validates phase, exact ref and round budget; the shared implementation also
// applies the goal-round blocked threshold and closing instruction
// (docs/agents/goal.md §3-§4).

import { updateGoal } from "../goal/shared.js";

export default {
  async run(args = {}, exec = {}) {
    return updateGoal(args, exec);
  },
};
