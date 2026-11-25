"use strict";

// Goal state: the durable event source and its strict replay fold
// (docs/agents/goal.md §1). Every accepted mutation appends one full-snapshot
// row to `goal_changes`; the current goal is derived by folding the rows in id
// order. `operation=round` rows are not mutations: they record that one goal
// round was admitted, which is the only way `roundsStarted` advances. `clear`
// writes a tombstone (no snapshot).
//
// Replay is strict: a malformed snapshot, a revision that does not advance by
// exactly one, an illegal phase transition, or a round beyond the cap makes the
// whole fold fail. Callers surface that failure instead of serving a half-valid
// goal. Activation (`armed` / `disarmed`) is process-local and never folded.

import { randomUUID } from "node:crypto";

const OPERATIONS = new Set(["create", "edit", "pause", "resume", "complete", "block", "clear", "round"]);
const PHASES = new Set(["active", "paused", "blocked", "complete"]);
const RESUME_PHASES = ["active", "paused", "blocked"];
const COMPLETE_PHASES = ["active", "paused", "blocked"];

const DEFAULT_MAX_GOAL_ROUNDS = 256;

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// Stable, machine-routable failure codes (same shape as DSH GoalError codes).
class GoalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function newGoalId() {
  return "goal-" + randomUUID();
}

function fail(message) {
  throw new GoalError("GOAL_REPLAY_FAILED", message);
}

function normalized(text) {
  return typeof text === "string" && text.length > 0 && text === text.trim();
}

// ---- fold ----

function emptyFold() {
  return {
    current: null,
    roundsStarted: 0,
    seenGoalIds: new Set(),
  };
}

// Decode one stored row. Returns { operation, goalId, revision, snapshot? }.
function decodeRow(row) {
  const where = "goal change " + String(row.id) + ": ";
  if (typeof row.goalId !== "string" || row.goalId.length === 0) fail(where + "goal id must be a non-empty string");
  if (!isPositiveInteger(row.revision)) fail(where + "revision must be a positive safe integer");
  if (!OPERATIONS.has(row.operation)) fail(where + "unknown operation " + JSON.stringify(row.operation));
  if (row.operation === "round" || row.operation === "clear") {
    return { operation: row.operation, goalId: row.goalId, revision: row.revision };
  }
  if (!normalized(row.objective)) fail(where + "objective must be non-empty and normalized");
  if (!isPositiveInteger(row.maxGoalRounds)) fail(where + "max_goal_rounds must be a positive safe integer");
  if (row.blockedReason !== undefined) {
    if (row.operation !== "block") fail(where + "a blocked reason is valid only for a block change");
    const code = row.blockedReason && row.blockedReason.code;
    const message = row.blockedReason && row.blockedReason.message;
    if (typeof code !== "string" || !KEBAB.test(code)) fail(where + "blocked code must be lower kebab-case");
    if (!normalized(message)) fail(where + "blocked message must be non-empty and normalized");
  }
  return {
    operation: row.operation,
    goalId: row.goalId,
    revision: row.revision,
    snapshot: {
      id: row.goalId,
      revision: row.revision,
      objective: row.objective,
      maxGoalRounds: row.maxGoalRounds,
      ...(row.blockedReason
        ? { blockedReason: { code: row.blockedReason.code, message: row.blockedReason.message } }
        : {}),
    },
  };
}

function applyRow(state, row) {
  const decoded = decodeRow(row);

  if (decoded.operation === "round") {
    const current = state.current;
    if (!current) fail("a goal round requires a current goal");
    if (current.phase !== "active") fail("a goal round requires an active goal");
    if (decoded.goalId !== current.id || decoded.revision !== current.revision) {
      fail("a goal round must carry the current goal id and revision");
    }
    state.roundsStarted += 1;
    if (state.roundsStarted > current.maxGoalRounds) fail("goal rounds exceed the configured limit");
    return;
  }

  if (decoded.operation === "clear") {
    const current = state.current;
    if (!current) fail("clear requires a current goal");
    if (decoded.goalId !== current.id || decoded.revision !== current.revision + 1) {
      fail("clear must advance the current goal by one revision");
    }
    state.current = null;
    state.roundsStarted = 0;
    return;
  }

  const current = state.current;
  const next = decoded.snapshot;

  if (decoded.operation === "create") {
    if (next.revision !== 1) fail("create must be revision one");
    if (current && current.phase !== "complete") fail("create requires no unfinished current goal");
    if (state.seenGoalIds.has(next.id)) fail("goal ids cannot be reused");
    state.seenGoalIds.add(next.id);
    state.current = { ...next, phase: "active" };
    state.roundsStarted = 0;
    return;
  }

  if (!current) fail(decoded.operation + " requires a current goal");
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    fail(decoded.operation + " must advance the current goal by one revision");
  }
  if (decoded.operation !== "edit") {
    if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
      fail(decoded.operation + " cannot change objective or max_goal_rounds");
    }
  }

  switch (decoded.operation) {
    case "edit":
      // An edit keeps the phase and the blocker; only the definition may change.
      state.current = {
        ...next,
        phase: current.phase,
        ...(current.blockedReason ? { blockedReason: current.blockedReason } : {}),
      };
      return;
    case "pause":
      if (current.phase !== "active") fail("pause requires an active goal");
      state.current = { ...next, phase: "paused" };
      return;
    case "resume":
      if (!RESUME_PHASES.includes(current.phase)) fail("resume requires active, paused or blocked");
      if (state.roundsStarted >= next.maxGoalRounds) fail("resume with an exhausted round budget");
      state.current = { ...next, phase: "active" };
      return;
    case "complete":
      if (!COMPLETE_PHASES.includes(current.phase)) fail("complete requires a non-complete goal");
      state.current = { ...next, phase: "complete" };
      return;
    case "block":
      if (current.phase !== "active") fail("block requires an active goal");
      if (!next.blockedReason) fail("block requires a blocked reason");
      state.current = { ...next, phase: "blocked" };
      return;
    default:
      fail("unknown operation");
  }
}

// Fold rows ordered by id. Throws GoalError("GOAL_REPLAY_FAILED", …) on the
// first invalid row; callers must not serve a goal from a failed fold.
function foldGoalChanges(rows) {
  const state = emptyFold();
  for (const row of rows) applyRow(state, row);
  return state;
}

// The model-visible goal value; `activation` is joined by the service.
function goalValue(state) {
  const goal = state.current;
  if (!goal) return { goal: null };
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: state.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason
        ? { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }
        : {}),
    },
  };
}

const __exports = {
  DEFAULT_MAX_GOAL_ROUNDS,
  GoalError,
  OPERATIONS,
  PHASES,
  RESUME_PHASES,
  COMPLETE_PHASES,
  KEBAB,
  newGoalId,
  foldGoalChanges,
  goalValue,
};
export {
  DEFAULT_MAX_GOAL_ROUNDS,
  GoalError,
  OPERATIONS,
  PHASES,
  RESUME_PHASES,
  COMPLETE_PHASES,
  KEBAB,
  newGoalId,
  foldGoalChanges,
  goalValue,
};
export default __exports;
