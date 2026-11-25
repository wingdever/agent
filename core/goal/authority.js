"use strict";

// Execution-time authority for the goal tools (docs/agents/goal.md §4).
//
// Three grants, in DSH's order of precedence:
//   - direct-human: the turn running right now contains an input whose source
//     is `user` (the human typed it in this turn). Only a root session holds it.
//   - goal-round: the turn's first input is the current goal's admitted round
//     (source `goal` reaching the model as a user message).
//   - none: everything else — subagents, producers that passed their own source
//     instead of `user`, a turn without a source.
//
// create / edit / pause / resume need direct-human; complete / blocked accept
// direct-human or goal-round. Source attribution is host-owned: every non-human
// producer passes its own source and cannot inherit `user`.

import { GoalError } from "./state.js";

const HUMAN_SOURCE = "user";
const GOAL_SOURCE = "goal";

function reject(message, code) {
  throw new GoalError(code, message);
}

// Inputs of the currently running turn from the same surface the model saw:
// the live request is authoritative for what the model can act on. Turn
// identity comes from the session's latest running turn row; without one the
// last user input alone is the anchor, so an earlier turn can never lend its
// grant.
async function currentTurnInputs(agent, context) {
  if (!agent || agent.sessionId == null) return [];
  if (!agent.turn) reject("goal tools require an open model turn", "GOAL_TOOL_DRIVER_REQUIRED");
  if (!context || typeof context.turnInputs !== "function") {
    reject("goal tools require the context service", "GOAL_TOOL_DRIVER_REQUIRED");
  }
  let turnSeq = null;
  try {
    const turns = await agent.store.run("turn.list", { session_id: agent.sessionId });
    const running = turns.filter((turn) => turn.status === "running").pop();
    if (running) turnSeq = Number(running.seq);
  } catch (_) {
    turnSeq = null;
  }
  const inputs = await context.turnInputs(agent.sessionId, turnSeq);
  if (turnSeq == null && inputs.length) return [inputs[inputs.length - 1]];
  return inputs;
}

// Grant for one tool call:
//   agent    — the calling instance
//   registry — agent registry (live identity check)
//   context  — context service (turn input projection)
//   goal     — current goal value ({ goal }) or null
//   action   — "read" | "human" | "terminal"
async function resolveGrant({ agent, registry, context, goal, action }) {
  if (!agent || !agent.turn) reject("goal tools require an open model turn", "GOAL_TOOL_DRIVER_REQUIRED");
  if (registry && typeof registry.get === "function" && agent.sessionId != null) {
    const live = registry.get(agent.sessionId);
    if (live && live !== agent) reject("goal tools require the live instance of this session", "GOAL_TOOL_DRIVER_REQUIRED");
  }
  const isRoot = agent.parentSessionId == null;
  const inputs = await currentTurnInputs(agent, context);
  const human = isRoot && inputs.some((input) => input.source === HUMAN_SOURCE);
  const first = inputs[0] || null;
  const current = goal && goal.goal ? goal.goal : null;
  const goalRound = !!(current && first && first.source === GOAL_SOURCE);

  if (action === "read") return human ? "direct-human" : goalRound ? "goal-round" : "none";
  if (action === "human") {
    if (!human) reject("this goal operation requires a direct human turn on a top-level agent", "GOAL_TOOL_HUMAN_REQUIRED");
    return "direct-human";
  }
  if (human) return "direct-human";
  if (goalRound) return "goal-round";
  reject("complete and blocked require a direct human turn or the current goal round", "GOAL_TOOL_AUTHORITY_REQUIRED");
}

const __exports = { resolveGrant, currentTurnInputs, HUMAN_SOURCE, GOAL_SOURCE };
export { resolveGrant, currentTurnInputs, HUMAN_SOURCE, GOAL_SOURCE };
export default __exports;
