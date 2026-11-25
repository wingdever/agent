"use strict";

// update_goal: CAS edit / pause / resume / complete / blocked, with the DSH
// authority split and blocked threshold. Shared implementation lives in
// tools/goal/shared.js (docs/agents/goal.md §3-§4).

import { updateGoal } from "../goal/shared.js";

export default {
  async run(args = {}, exec = {}) {
    return updateGoal(args, exec);
  },
};
