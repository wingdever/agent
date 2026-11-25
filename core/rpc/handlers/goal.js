"use strict";

// Goal control surface (docs/agents/goal.md §5): the human-facing half of the
// goal domain. Commands execute outside any model turn — they never enter the
// conversation, never spend tokens and never need the model to cooperate.
//
// The grammar is DSH's /goal command, mapped onto RPC:
//   control words (pause, resume, clear, edit) are exact; anything else is an
//   objective. `edit` refuses to replace an unfinished goal.
//
// Every mutation carries the exact { goal_id, revision } the caller last read;
// a stale ref is reported instead of overwriting a newer state.

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };

const goalGet = {
  type: "object",
  properties: { session_id: anyId },
  additionalProperties: false,
};

const goalCreate = {
  type: "object",
  properties: {
    session_id: anyId,
    objective: { type: "string" },
    max_goal_rounds: { type: "number" },
  },
  required: ["session_id", "objective"],
  additionalProperties: false,
};

const goalMutate = {
  type: "object",
  properties: {
    session_id: anyId,
    goal_id: { type: "string" },
    revision: { type: "number" },
    objective: { type: "string" },
    max_goal_rounds: { type: "number" },
  },
  required: ["session_id", "goal_id", "revision"],
  additionalProperties: false,
};

// What the control surface shows and which commands remain valid. `driver`
// reports the continuation driver's live view (reservation phase, whether a
// round's turn is running), so the UI can tell "armed and working" from
// "armed and waiting for an event".
function statusOf(core, value, sessionId) {
  const goal = value ? value.goal : null;
  const driver = core.goals && core.goals.driver && typeof core.goals.driver.describe === "function"
    ? core.goals.driver.describe(sessionId)
    : null;
  if (!goal) {
    return { goal: null, activation: value ? value.activation : "disarmed", driver, commands: ["create"] };
  }
  const commands = [];
  if (goal.phase === "active") commands.push("pause");
  if (["active", "paused", "blocked"].includes(goal.phase)) commands.push("resume");
  commands.push("edit", "clear");
  return { goal, activation: value.activation, driver, commands };
}

export default function defineGoalCommands(rpc) {
  rpc.define({
    name: "goal.get",
    params: goalGet,
    handler: async (core, params) => statusOf(core, await core.goals.get(params.session_id), params.session_id),
  });

  rpc.define({
    name: "goal.create",
    params: goalCreate,
    handler: async (core, params) => statusOf(core, await core.goals.create(params.session_id, {
      objective: params.objective,
      maxGoalRounds: params.max_goal_rounds,
    }), params.session_id),
  });

  rpc.define({
    name: "goal.edit",
    params: goalMutate,
    handler: async (core, params) => statusOf(core, await core.goals.edit(
      params.session_id,
      { id: params.goal_id, revision: params.revision },
      { objective: params.objective, maxGoalRounds: params.max_goal_rounds },
    ), params.session_id),
  });

  rpc.define({
    name: "goal.pause",
    params: goalMutate,
    handler: async (core, params) => statusOf(core, await core.goals.pause(
      params.session_id,
      { id: params.goal_id, revision: params.revision },
    ), params.session_id),
  });

  // The human control surface is the only path that resumes a durable paused
  // goal; the goal tools reject it.
  rpc.define({
    name: "goal.resume",
    params: goalMutate,
    handler: async (core, params) => statusOf(core, await core.goals.resume(
      params.session_id,
      { id: params.goal_id, revision: params.revision },
      { fromPaused: true },
    ), params.session_id),
  });

  rpc.define({
    name: "goal.clear",
    params: goalMutate,
    handler: async (core, params) => {
      await core.goals.clear(params.session_id, { id: params.goal_id, revision: params.revision });
      return statusOf(core, await core.goals.get(params.session_id), params.session_id);
    },
  });
}
