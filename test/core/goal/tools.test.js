"use strict";

// Goal tool boundary: the tools no longer authorize by caller/source. They
// still delegate phase, exact-ref CAS, activation and budget rules to
// GoalService, and use the goal-round claim only for the blocked threshold and
// the closing instruction. These tests use a plain session-shaped agent so no
// live instance or goal driver interferes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.js";

function agentFor(h, { parentSessionId = null, turn = null } = {}) {
  return { sessionId: h.session.id, parentSessionId, turn };
}

function execFor(h, agent, toolName) {
  return {
    agent,
    goals: h.goals,
    tool: h.core.tools.get(toolName),
  };
}

function goalOf(result) {
  return result.meta.goal;
}

test("a non-root agent with no source and no open turn can create, edit and pause a goal", async () => {
  const h = await createHarness();
  try {
    const agent = agentFor(h, { parentSessionId: "subagent-1", turn: null });
    const create = h.core.tools.get("create_goal");
    const update = h.core.tools.get("update_goal");
    const get = h.core.tools.get("get_goal");

    const created = await create.run(
      { objective: "ship the refactor", max_goal_rounds: 5 },
      execFor(h, agent, "create_goal"),
    );
    const goal = goalOf(created);
    assert.equal(goal.phase, "active");
    assert.equal(created.meta.activation, "armed");

    const read = await get.run({}, execFor(h, agent, "get_goal"));
    assert.equal(goalOf(read).id, goal.id);

    const edited = await update.run(
      { goal_id: goal.id, revision: goal.revision, action: "edit", objective: "ship it safely" },
      execFor(h, agent, "update_goal"),
    );
    assert.equal(goalOf(edited).objective, "ship it safely");

    const paused = await update.run(
      { goal_id: goal.id, revision: goalOf(edited).revision, action: "pause" },
      execFor(h, agent, "update_goal"),
    );
    assert.equal(goalOf(paused).phase, "paused");
    assert.equal(paused.meta.activation, "disarmed");
  } finally {
    await h.close();
  }
});

test("a non-goal turn can complete or block immediately without a closing instruction", async () => {
  const h = await createHarness();
  try {
    const agent = agentFor(h, { parentSessionId: "subagent-2", turn: null });
    const create = h.core.tools.get("create_goal");
    const update = h.core.tools.get("update_goal");

    const first = await create.run({ objective: "complete me", max_goal_rounds: 5 }, execFor(h, agent, "create_goal"));
    const firstGoal = goalOf(first);
    const deferred = [];
    const completed = await update.run(
      { goal_id: firstGoal.id, revision: firstGoal.revision, action: "complete" },
      { ...execFor(h, agent, "update_goal"), deferContext: (text) => deferred.push(text) },
    );
    assert.equal(goalOf(completed).phase, "complete");
    assert.equal(deferred.length, 0, "a non-goal turn has no autonomous-run closing instruction");

    const second = await create.run({ objective: "block me", max_goal_rounds: 5 }, execFor(h, agent, "create_goal"));
    const secondGoal = goalOf(second);
    const blocked = await update.run(
      { goal_id: secondGoal.id, revision: secondGoal.revision, action: "blocked", blocked_reason: "external dependency is unavailable" },
      { ...execFor(h, agent, "update_goal"), deferContext: (text) => deferred.push(text) },
    );
    assert.equal(goalOf(blocked).phase, "blocked");
    assert.equal(deferred.length, 0, "the blocked threshold is a goal-round policy, not a caller check");
  } finally {
    await h.close();
  }
});

test("a goal-round turn still enforces the blocked threshold and injects the closing instruction", async () => {
  const h = await createHarness();
  try {
    const agent = agentFor(h, { turn: null });
    const create = h.core.tools.get("create_goal");
    const update = h.core.tools.get("update_goal");

    const created = await create.run({ objective: "keep working", max_goal_rounds: 10 }, execFor(h, agent, "create_goal"));
    const goal = goalOf(created);
    const ref = { id: goal.id, revision: goal.revision };

    agent.turn = { claim: { goalRound: { round: 1 } } };
    await assert.rejects(
      update.run(
        { goal_id: goal.id, revision: goal.revision, action: "blocked", blocked_reason: "still stuck" },
        execFor(h, agent, "update_goal"),
      ),
      /blocked requires at least 3 consecutive goal rounds/,
    );

    for (let i = 0; i < 3; i += 1) await h.goals.admitRound(h.session.id, ref);

    const deferred = [];
    const blocked = await update.run(
      { goal_id: goal.id, revision: goal.revision, action: "blocked", blocked_reason: "still stuck" },
      { ...execFor(h, agent, "update_goal"), deferContext: (text) => deferred.push(text) },
    );
    assert.equal(goalOf(blocked).phase, "blocked");
    assert.equal(goalOf(blocked).roundsStarted, 3);
    assert.equal(deferred.length, 1);
    assert.match(deferred[0], /<goal_blocked>/);
  } finally {
    await h.close();
  }
});

test("a goal-round completion still injects the closing instruction", async () => {
  const h = await createHarness();
  try {
    const agent = agentFor(h, { turn: { claim: { goalRound: { round: 1 } } } });
    const create = h.core.tools.get("create_goal");
    const update = h.core.tools.get("update_goal");

    const created = await create.run({ objective: "finish and close", max_goal_rounds: 5 }, execFor(h, agent, "create_goal"));
    const goal = goalOf(created);
    const deferred = [];
    const completed = await update.run(
      { goal_id: goal.id, revision: goal.revision, action: "complete" },
      { ...execFor(h, agent, "update_goal"), deferContext: (text) => deferred.push(text) },
    );
    assert.equal(goalOf(completed).phase, "complete");
    assert.equal(deferred.length, 1);
    assert.match(deferred[0], /<goal_complete>/);
  } finally {
    await h.close();
  }
});

test("the tool resume path still refuses paused while the control surface can resume it", async () => {
  const h = await createHarness();
  try {
    const agent = agentFor(h, { turn: null });
    const create = h.core.tools.get("create_goal");
    const update = h.core.tools.get("update_goal");

    const created = await create.run({ objective: "pause then resume", max_goal_rounds: 5 }, execFor(h, agent, "create_goal"));
    const goal = goalOf(created);
    const paused = await update.run(
      { goal_id: goal.id, revision: goal.revision, action: "pause" },
      execFor(h, agent, "update_goal"),
    );
    const pausedGoal = goalOf(paused);

    await assert.rejects(
      update.run(
        { goal_id: pausedGoal.id, revision: pausedGoal.revision, action: "resume" },
        execFor(h, agent, "update_goal"),
      ),
      /is paused; resume it from the goal control/,
    );

    const resumed = await h.goals.resume(
      h.session.id,
      { id: pausedGoal.id, revision: pausedGoal.revision },
      { fromPaused: true },
    );
    assert.equal(resumed.goal.phase, "active");
    assert.equal(resumed.activation, "armed");
  } finally {
    await h.close();
  }
});

test("GoalService still rejects a stale revision after the caller gate is gone", async () => {
  const h = await createHarness();
  try {
    const agent = agentFor(h, { turn: null });
    const create = h.core.tools.get("create_goal");
    const update = h.core.tools.get("update_goal");

    const created = await create.run({ objective: "cas still applies", max_goal_rounds: 5 }, execFor(h, agent, "create_goal"));
    const goal = goalOf(created);
    const edited = await update.run(
      { goal_id: goal.id, revision: goal.revision, action: "edit", objective: "new version" },
      execFor(h, agent, "update_goal"),
    );
    assert.equal(goalOf(edited).revision, goal.revision + 1);
    await assert.rejects(
      update.run(
        { goal_id: goal.id, revision: goal.revision, action: "edit", objective: "stale write" },
        execFor(h, agent, "update_goal"),
      ),
      /stale goal ref/,
    );
  } finally {
    await h.close();
  }
});
