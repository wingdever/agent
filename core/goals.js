"use strict";

// Persisted same-session goal state for create_goal / get_goal / update_goal.
// The automatic continuation-round driver is not implemented yet: roundsStarted
// stays 0, so create/get/edit/pause/resume/complete/blocked are model-callable
// without the DSH goal-round authority checks. The state and revision CAS are
// real, and the tool results match DSH's goal value shape.

const { randomUUID } = require("crypto");

const DEFAULT_MAX_ROUNDS = 256;

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(field + " must be a positive safe integer");
  }
  return value;
}

function goalValue(goal) {
  if (!goal) return { goal: null };
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason ? { blockedReason: {
        code: goal.blockedReason.code,
        message: goal.blockedReason.message,
      } } : {}),
    },
    activation: goal.activation,
  };
}

function hasText(value) {
  return typeof value === "string" && value.length > 0;
}

function createGoalService(store) {
  async function read(sessionId) {
    if (!store || sessionId == null || sessionId === "") {
      throw new Error("goal tools require a session");
    }
    return store.run("goal.get", { session_id: sessionId });
  }

  async function write(sessionId, goal) {
    return store.run("goal.save", { session_id: sessionId, goal });
  }

  return {
    async get(sessionId) {
      return goalValue(await read(sessionId));
    },

    async create(sessionId, args = {}) {
      const current = await read(sessionId);
      if (current && current.phase !== "complete") {
        throw new Error('goal "' + current.id + '" already exists with phase "' + current.phase + '"');
      }
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      if (!objective) throw new Error("goal objective must be a non-empty string");
      const maxGoalRounds = args.max_goal_rounds === undefined
        ? DEFAULT_MAX_ROUNDS
        : positiveInteger(args.max_goal_rounds, "max_goal_rounds");
      const goal = {
        id: "goal-" + randomUUID(),
        revision: 1,
        objective,
        phase: "active",
        roundsStarted: 0,
        maxGoalRounds,
        activation: "armed",
      };
      return goalValue(await write(sessionId, goal));
    },

    async update(sessionId, args = {}) {
      const current = await read(sessionId);
      if (!current) throw new Error("no current goal");
      const goalId = typeof args.goal_id === "string" ? args.goal_id : "";
      if (!goalId.trim() || !Number.isSafeInteger(args.revision) || args.revision < 1) {
        throw new Error("goal_id must be non-empty and revision must be a positive safe integer");
      }
      if (goalId !== current.id || args.revision !== current.revision) {
        throw new Error(
          'stale goal ref "' + goalId + '" revision ' + args.revision +
          '; current is "' + current.id + '" revision ' + current.revision
        );
      }
      const action = args.action;
      const hasObjective = hasText(args.objective);
      const hasCap = args.max_goal_rounds !== undefined && args.max_goal_rounds !== 0;
      const hasReason = hasText(args.blocked_reason);

      if (action === "edit") {
        if (!hasObjective && !hasCap) throw new Error("goal edit requires objective and/or maxGoalRounds");
        if (hasReason) throw new Error("blocked_reason is valid only with action blocked");
        const next = {
          ...current,
          revision: current.revision + 1,
          ...(hasObjective ? { objective: args.objective.trim() } : {}),
          ...(hasCap ? { maxGoalRounds: positiveInteger(args.max_goal_rounds, "max_goal_rounds") } : {}),
        };
        if (hasObjective && !next.objective) throw new Error("goal objective must be a non-empty string");
        return goalValue(await write(sessionId, next));
      }

      if (action === "pause" || action === "resume") {
        if (hasObjective || hasCap || hasReason) {
          throw new Error("objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked");
        }
        if (action === "pause") {
          if (current.phase !== "active") {
            throw new Error('cannot pause goal "' + current.id + '" from phase "' + current.phase + '"; expected active');
          }
          return goalValue(await write(sessionId, {
            ...current,
            revision: current.revision + 1,
            phase: "paused",
            activation: "disarmed",
          }));
        }
        if (!["active", "paused", "blocked"].includes(current.phase)) {
          throw new Error('cannot resume goal "' + current.id + '" from phase "' + current.phase + '"; expected active or paused or blocked');
        }
        if (current.phase === "active" && current.activation === "armed") {
          throw new Error('goal "' + current.id + '" is already active and armed');
        }
        if (current.roundsStarted >= current.maxGoalRounds) {
          throw new Error('goal "' + current.id + '" exhausted ' + current.maxGoalRounds + " goal rounds; increase maxGoalRounds before resuming");
        }
        const { blockedReason: _ignored, ...resumed } = current;
        return goalValue(await write(sessionId, {
          ...resumed,
          revision: current.revision + 1,
          phase: "active",
          activation: "armed",
        }));
      }

      if (action === "complete") {
        if (hasObjective || hasCap) throw new Error("objective and max_goal_rounds are valid only with action edit");
        if (hasReason) throw new Error("blocked_reason is valid only with action blocked");
        if (!["active", "paused", "blocked"].includes(current.phase)) {
          throw new Error('cannot complete goal "' + current.id + '" from phase "' + current.phase + '"; expected active or paused or blocked');
        }
        const { blockedReason: _ignored, ...completed } = current;
        return goalValue(await write(sessionId, {
          ...completed,
          revision: current.revision + 1,
          phase: "complete",
          activation: "disarmed",
        }));
      }

      if (action === "blocked") {
        if (hasObjective || hasCap) throw new Error("objective and max_goal_rounds are valid only with action edit");
        if (!hasReason) throw new Error("blocked_reason is required with action blocked");
        if (current.phase !== "active") {
          throw new Error('cannot block goal "' + current.id + '" from phase "' + current.phase + '"; expected active');
        }
        return goalValue(await write(sessionId, {
          ...current,
          revision: current.revision + 1,
          phase: "blocked",
          activation: "disarmed",
          blockedReason: { code: "model-reported", message: args.blocked_reason.trim() },
        }));
      }

      throw new Error('unknown goal action "' + action + '"');
    },
  };
}

module.exports = { createGoalService, goalValue, DEFAULT_MAX_ROUNDS };
