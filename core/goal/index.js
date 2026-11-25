"use strict";

// Goal service: durable lifecycle mutations over the `goal_changes` event
// source plus the process-local continuation activation (docs/agents/goal.md).
//
// The service owns no policy beyond the phase machine:
//   - mutations take an exact { id, revision } ref and reject stale refs;
//   - `resume` is the only path that yields an armed goal;
//   - `clear` writes a tombstone;
//   - `admitRound` appends the round row that advances roundsStarted.
//
// Authority (which caller may run which verb) is enforced by the goal tools,
// not here. Activation is per session in this process and starts `disarmed`
// for every agent instance (goal.md §7): a session restored or reopened after a
// restart never continues on its own until someone resumes it.

import { GoalRoundDriver } from "./driver.js";
import { createGoalStore } from "./store.js";
import {
  DEFAULT_MAX_GOAL_ROUNDS,
  GoalError,
  newGoalId,
  foldGoalChanges,
  goalValue,
} from "./state.js";

function detached(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class GoalService {
  constructor({ store, goalStore = null, defaultMaxGoalRounds = DEFAULT_MAX_GOAL_ROUNDS, onChange = () => {} } = {}) {
    if (!store && !goalStore) throw new Error("GoalService requires a store");
    // The goal's own storage: table, append order and row shape live in the
    // module, the generic store only supplies the primitives.
    this.goalStore = goalStore || createGoalStore(store);
    if (!Number.isSafeInteger(defaultMaxGoalRounds) || defaultMaxGoalRounds < 1) {
      throw new TypeError("defaultMaxGoalRounds must be a positive safe integer");
    }
    this.store = store;
    this.defaultMaxGoalRounds = defaultMaxGoalRounds;
    // Process-local activation per session key. A fresh process starts disarmed.
    this.activation = new Map();
    // Serializes read-fold-append per session so two mutations cannot both
    // observe the same revision.
    this._locks = new Map();
    this.onChange = onChange; // (event) => void; the driver subscribes
  }

  // ---- storage + projection ----

  async _read(sessionId) {
    const rows = await this.goalStore.list(sessionId);
    try {
      return foldGoalChanges(rows);
    } catch (error) {
      throw new GoalError(error.code || "GOAL_REPLAY_FAILED", String(error.message || error));
    }
  }

  _activationOf(sessionId) {
    return this.activation.get(String(sessionId)) || "disarmed";
  }

  _setActivation(sessionId, activation) {
    const key = String(sessionId);
    const previous = this._activationOf(sessionId);
    this.activation.set(key, activation);
    if (previous !== activation) {
      this.onChange({ type: "activation", sessionId, activation });
    }
  }

  _view(sessionId, state) {
    return { ...goalValue(state), activation: this._activationOf(sessionId) };
  }

  async _withLock(sessionId, task) {
    const key = String(sessionId);
    const previous = this._locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this._locks.set(key, previous.then(() => current));
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this._locks.get(key) === current) this._locks.delete(key);
    }
  }

  async _append(sessionId, change) {
    const row = await this.goalStore.append({
      sessionId,
      revision: change.revision,
      operation: change.operation,
      goalId: change.goalId,
      objective: change.objective,
      maxGoalRounds: change.maxGoalRounds,
      blockedReason: change.blockedReason,
    });
    this.onChange({ type: "change", sessionId, operation: change.operation, goalId: change.goalId, revision: change.revision });
    return row;
  }

  // ---- reads ----

  // Read the current goal. A read of an instantiated session also re-arms
  // nothing; it only refreshes activation for sessions that already exist.
  async get(sessionId) {
    return this._view(sessionId, await this._read(sessionId));
  }

  // Narrow read for the driver.
  async state(sessionId) {
    return this._read(sessionId);
  }

  activationOf(sessionId) {
    return this._activationOf(sessionId);
  }

  // ---- activation ----

  // Disarm without touching the durable phase or revision (instance-created
  // edge, max-tokens stop, checkpoint failure, teardown).
  disarm(sessionId) {
    this._setActivation(sessionId, "disarmed");
  }

  // ---- lifecycle mutations ----

  async create(sessionId, { objective, maxGoalRounds } = {}) {
    return this._withLock(sessionId, async () => {
      const state = await this._read(sessionId);
      const current = state.current;
      if (current && current.phase !== "complete") {
        throw new GoalError("GOAL_ALREADY_EXISTS", 'goal "' + current.id + '" already exists with phase "' + current.phase + '"');
      }
      const text = typeof objective === "string" ? objective.trim() : "";
      if (!text) throw new GoalError("GOAL_INVALID_CREATE", "goal objective must be a non-empty string");
      const cap = maxGoalRounds === undefined || maxGoalRounds === null
        ? this.defaultMaxGoalRounds
        : maxGoalRounds;
      if (!Number.isSafeInteger(cap) || cap < 1) {
        throw new GoalError("GOAL_INVALID_CREATE", "max_goal_rounds must be a positive safe integer");
      }
      const goalId = newGoalId();
      await this._append(sessionId, { revision: 1, operation: "create", goalId, objective: text, maxGoalRounds: cap });
      this._setActivation(sessionId, "armed");
      return this._view(sessionId, await this._read(sessionId));
    });
  }

  _expect(state, ref) {
    if (!state.current) throw new GoalError("GOAL_NOT_FOUND", "no current goal");
    if (!ref || typeof ref.id !== "string" || ref.id.length === 0 || !Number.isSafeInteger(ref.revision) || ref.revision < 1) {
      throw new GoalError("GOAL_INVALID_REF", "goal_id must be non-empty and revision must be a positive safe integer");
    }
    if (ref.id !== state.current.id || ref.revision !== state.current.revision) {
      throw new GoalError(
        "GOAL_STALE_REVISION",
        'stale goal ref "' + ref.id + '" revision ' + ref.revision + "; current is \"" + state.current.id + '" revision ' + state.current.revision,
      );
    }
    return state.current;
  }

  _snapshotChange(current, operation, patch) {
    return {
      revision: current.revision + 1,
      operation,
      goalId: current.id,
      objective: current.objective,
      maxGoalRounds: current.maxGoalRounds,
      ...patch,
    };
  }

  async _mutate(sessionId, ref, operation, { check, patch, activation }) {
    return this._withLock(sessionId, async () => {
      const state = await this._read(sessionId);
      const current = this._expect(state, ref);
      if (check && !check(current, state)) {
        throw new GoalError("GOAL_INVALID_TRANSITION", 'cannot ' + operation + ' goal "' + current.id + '" from phase "' + current.phase + '"');
      }
      await this._append(sessionId, this._snapshotChange(current, operation, patch(current, state)));
      if (activation !== undefined) this._setActivation(sessionId, activation);
      return this._view(sessionId, await this._read(sessionId));
    });
  }

  async edit(sessionId, ref, { objective, maxGoalRounds } = {}) {
    const hasObjective = typeof objective === "string" && objective !== "";
    const hasCap = maxGoalRounds !== undefined && maxGoalRounds !== null && maxGoalRounds !== 0;
    if (!hasObjective && !hasCap) {
      throw new GoalError("GOAL_INVALID_EDIT", "goal edit requires objective and/or max_goal_rounds");
    }
    if (hasObjective && objective.trim() === "") {
      throw new GoalError("GOAL_INVALID_EDIT", "goal objective must be a non-empty string");
    }
    if (hasCap && (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1)) {
      throw new GoalError("GOAL_INVALID_EDIT", "max_goal_rounds must be a positive safe integer");
    }
    return this._mutate(sessionId, ref, "edit", {
      patch: (current) => ({
        objective: hasObjective ? objective.trim() : current.objective,
        maxGoalRounds: hasCap ? maxGoalRounds : current.maxGoalRounds,
      }),
    });
  }

  async pause(sessionId, ref) {
    return this._mutate(sessionId, ref, "pause", {
      check: (current) => current.phase === "active",
      patch: () => ({}),
      activation: "disarmed",
    });
  }

  // Resume a stopped goal, or rearm an active one after a session-start edge.
  // `fromPaused` is false for the model tool path: a durable paused goal belongs
  // to the human control surface.
  async resume(sessionId, ref, { fromPaused = true } = {}) {
    return this._withLock(sessionId, async () => {
      const state = await this._read(sessionId);
      const current = this._expect(state, ref);
      if (!["active", "paused", "blocked"].includes(current.phase)) {
        throw new GoalError("GOAL_INVALID_TRANSITION", 'cannot resume goal "' + current.id + '" from phase "' + current.phase + '"');
      }
      if (current.phase === "paused" && !fromPaused) {
        throw new GoalError("GOAL_RESUME_PAUSED", 'goal "' + current.id + '" is paused; resume it from the goal control');
      }
      if (current.phase === "active" && this._activationOf(sessionId) === "armed") {
        throw new GoalError("GOAL_INVALID_TRANSITION", 'goal "' + current.id + '" is already active and armed');
      }
      if (state.roundsStarted >= current.maxGoalRounds) {
        throw new GoalError(
          "GOAL_INVALID_TRANSITION",
          'goal "' + current.id + '" exhausted ' + current.maxGoalRounds + " goal rounds; increase max_goal_rounds before resuming",
        );
      }
      await this._append(sessionId, this._snapshotChange(current, "resume", {}));
      this._setActivation(sessionId, "armed");
      return this._view(sessionId, await this._read(sessionId));
    });
  }

  async complete(sessionId, ref) {
    return this._mutate(sessionId, ref, "complete", {
      check: (current) => current.phase !== "complete",
      patch: () => ({}),
      activation: "disarmed",
    });
  }

  async block(sessionId, ref, { code, message } = {}) {
    if (typeof code !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)) {
      throw new GoalError("GOAL_INVALID_BLOCK", "blocked code must be lower kebab-case");
    }
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) throw new GoalError("GOAL_INVALID_BLOCK", "blocked message must be a non-empty string");
    return this._mutate(sessionId, ref, "block", {
      check: (current) => current.phase === "active",
      patch: () => ({ blockedReason: { code, message: text } }),
      activation: "disarmed",
    });
  }

  async clear(sessionId, ref) {
    return this._withLock(sessionId, async () => {
      const state = await this._read(sessionId);
      const current = this._expect(state, ref);
      await this._append(sessionId, { revision: current.revision + 1, operation: "clear", goalId: current.id });
      this._setActivation(sessionId, "disarmed");
      return { cleared: { id: current.id, revision: current.revision + 1 } };
    });
  }

  // ---- rounds ----

  // Admit one goal round: only an armed active goal with capacity may consume a
  // round number. Appends the round row; the caller (driver) owns reservation
  // and delivery.
  async admitRound(sessionId, ref) {
    return this._withLock(sessionId, async () => {
      const state = await this._read(sessionId);
      const current = this._expect(state, ref);
      if (current.phase !== "active") {
        throw new GoalError("GOAL_INVALID_TRANSITION", "a goal round requires an active goal");
      }
      if (this._activationOf(sessionId) !== "armed") {
        throw new GoalError("GOAL_NOT_ARMED", 'goal "' + current.id + '" is not armed');
      }
      if (state.roundsStarted >= current.maxGoalRounds) {
        throw new GoalError("GOAL_ROUND_LIMIT", 'goal "' + current.id + '" exhausted ' + current.maxGoalRounds + " goal rounds");
      }
      await this._append(sessionId, { revision: current.revision, operation: "round", goalId: current.id });
      const after = await this._read(sessionId);
      this.onChange({ type: "round", sessionId, goalId: current.id, revision: current.revision, round: after.roundsStarted });
      return { ...this._view(sessionId, after), round: after.roundsStarted };
    });
  }
}

function createGoalService(store, options = {}) {
  return new GoalService({ store, ...options });
}

// Mount the goal module on a composed core. This is the module's only entry
// point from the composition root: it creates the service, attaches the round
// driver through the generic turn lifecycle interfaces (docs/agents/
// lifecycle.md), and returns the public handle (core.goals).
function mountGoal(core, { defaultMaxGoalRounds } = {}) {
  if (!core || !core.store || !core.agent) throw new Error("mountGoal requires core.store and core.agent");
  const goals = createGoalService(core.store, { defaultMaxGoalRounds });
  const driver = new GoalRoundDriver({
    goals,
    runtime: core.agent,
    logger: console,
  });
  goals.driver = driver;
  goals.onChange = (event) => driver.notify(event);
  driver.start();
  return goals;
}

const __exports = { GoalService, createGoalService, mountGoal };
export { GoalService, createGoalService, mountGoal };
export default __exports;
