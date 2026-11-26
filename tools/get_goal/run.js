"use strict";

// get_goal: read the current session goal plus the process-local activation.
// Result shape and the shared implementation live in tools/goal/shared.js
// (docs/agents/goal.md §3-§4).

import { getGoal } from "../goal/shared.js";

export default {
  async run(args = {}, exec = {}) {
    return getGoal(args, exec);
  },
};
