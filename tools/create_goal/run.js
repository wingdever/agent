"use strict";

// create_goal: create (and arm) the session goal from a direct human turn.
// Authority, result shape and the shared implementation live in
// tools/goal/shared.js (docs/agents/goal.md §3-§4).

import { createGoal } from "../goal/shared.js";

export default {
  async run(args = {}, exec = {}) {
    return createGoal(args, exec);
  },
};
