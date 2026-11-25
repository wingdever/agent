"use strict";

// End-to-end goal round driver: real loop, real runtime, scripted model.
// Covers the DSH semantics adopted in docs/agents/goal.md §6-§7.
//
// The scenarios open the session first and then create (and arm) a goal on it:
// a live idle instance with an armed goal is the state in which the driver
// continues rounds. The "restart" scenario covers the opposite edge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, reply, goalRoundInputs, waitFor, tick } from "./harness.js";

const ROUND = /Round: (\d+)\/(\d+)/;

function currentRound(messages) {
  const rounds = goalRoundInputs(messages);
  if (!rounds.length) return 0;
  const match = ROUND.exec(rounds[rounds.length - 1]);
  return match ? Number(match[1]) : 0;
}

test("an armed goal on a live session continues round after round", async () => {
  const h = await createHarness({ script: (messages) => reply("worked round " + currentRound(messages)) });
  try {
    await h.openSession();
    const created = await h.goals.create(h.session.id, { objective: "keep going", maxGoalRounds: 10 });
    assert.equal(created.activation, "armed");
    const view = await waitFor(async () => {
      const v = await h.goals.get(h.session.id);
      return v.goal.roundsStarted >= 3 ? v : null;
    });
    assert.equal(view.goal.phase, "active");
    assert.equal(view.activation, "armed");
    // Every round's prompt stays in history, so the last request carries them
    // all; check the sequence rather than two ad-hoc entries.
    const rounds = goalRoundInputs(h.requests[h.requests.length - 1]);
    assert.ok(rounds.length >= 3, "the model must have seen at least three <goal_round> inputs");
    assert.match(rounds[0], /Objective: "keep going"/);
    assert.match(rounds[0], /Round: 1\/10/);
    assert.match(rounds[1], /Round: 2\/10/);
    const rows = await h.goals.goalStore.list(h.session.id);
    assert.equal(rows.filter((row) => row.operation === "round").length, view.goal.roundsStarted);
  } finally {
    await h.close();
  }
});

test("the round cap ends in a round-limit blocker and no further rounds", async () => {
  const h = await createHarness({ script: () => reply("more work") });
  try {
    await h.openSession();
    await h.goals.create(h.session.id, { objective: "never done", maxGoalRounds: 2 });
    const view = await waitFor(async () => {
      const v = await h.goals.get(h.session.id);
      return v.goal && v.goal.phase === "blocked" ? v : null;
    });
    assert.equal(view.goal.blockedReason.code, "round-limit");
    assert.equal(view.goal.roundsStarted, 2);
    assert.equal(view.activation, "disarmed");
    const calls = h.calls;
    await tick(100);
    assert.equal(h.calls, calls, "a blocked goal must not start another round");
  } finally {
    await h.close();
  }
});

test("a truncated round disarms the goal and never restarts on its own", async () => {
  const h = await createHarness({
    script: (messages) => (currentRound(messages) === 0
      ? reply("first")
      : { content: "cut", tool_calls: null, finish_reason: "length" }),
  });
  try {
    await h.openSession();
    await h.goals.create(h.session.id, { objective: "truncate", maxGoalRounds: 10 });
    await waitFor(async () => (await h.goals.get(h.session.id)).activation === "disarmed");
    const view = await h.goals.get(h.session.id);
    assert.equal(view.goal.phase, "active", "truncation keeps the goal active");
    const calls = h.calls;
    await tick(120);
    assert.equal(h.calls, calls, "no round may start after truncation");
  } finally {
    await h.close();
  }
});

test("a session reopened after a restart is disarmed until a resume", async () => {
  const h = await createHarness({
    script: (messages) => {
      // Two rounds is enough; the scenario needs the goal to stay unfinished.
      if (currentRound(messages) >= 2) return { content: "pausing here", tool_calls: null, finish_reason: "length" };
      return reply("round " + currentRound(messages));
    },
  });
  try {
    await h.openSession();
    await h.goals.create(h.session.id, { objective: "restart", maxGoalRounds: 10 });
    await waitFor(async () => (await h.goals.get(h.session.id)).activation === "disarmed");
    // Restart: the instance goes away, the process-local activation cache is
    // gone, and the session is instantiated again on demand.
    h.agent.registry.dispose(h.session.id);
    h.goals.activation.clear();
    assert.equal(h.goals.activationOf(h.session.id), "disarmed");
    // Let the round that was in flight when the instance was released settle
    // before counting calls.
    await tick(120);
    const calls = h.calls;
    await tick(150);
    assert.equal(h.calls, calls, "a reopened session must not continue on its own");
    // The reopened session is instantiated by a human turn; the goal stays
    // disarmed until it is explicitly resumed.
    await h.agent.chat({ sessionId: h.session.id, messages: [{ role: "user", content: "I am back" }] });
    await tick(100);
    const view = await h.goals.get(h.session.id);
    assert.equal(view.goal.phase, "active");
    assert.equal(view.activation, "disarmed");
    // The human's turn may already have carried the next round behind it (the
    // resumed-session contract: arming re-arms continuation for turns that
    // follow), so the assertion is on the goal, not on a call count.
    assert.ok(h.calls >= calls + 1, "the human turn ran");
    // An explicit resume is the human's instruction to continue: the driver
    // arms it and the next round follows without another human turn.
    const roundsBefore = view.goal.roundsStarted;
    const resumed = await h.goals.resume(h.session.id, { id: view.goal.id, revision: view.goal.revision }, { fromPaused: true });
    assert.equal(resumed.activation, "armed");
    const afterResume = await waitFor(async () => {
      const v = await h.goals.get(h.session.id);
      return v.goal.roundsStarted > roundsBefore ? v : null;
    });
    assert.ok(afterResume.goal.roundsStarted > roundsBefore, "resume continues the goal");
  } finally {
    await h.close();
  }
});

test("pause stops the rounds and resume continues them", async () => {
  const h = await createHarness({ script: (messages) => reply("round " + currentRound(messages)) });
  try {
    await h.openSession();
    await h.goals.create(h.session.id, { objective: "resume me", maxGoalRounds: 10 });
    await waitFor(async () => (await h.goals.get(h.session.id)).goal.roundsStarted >= 1);
    const view = await h.goals.get(h.session.id);
    await h.goals.pause(h.session.id, { id: view.goal.id, revision: view.goal.revision });
    await tick(150);
    const paused = h.calls;
    await tick(120);
    assert.equal(h.calls, paused, "a paused goal does not run");
    const state = await h.goals.get(h.session.id);
    assert.equal(state.goal.phase, "paused");
    assert.equal(state.activation, "disarmed");
    const resumed = await h.goals.resume(h.session.id, { id: state.goal.id, revision: state.goal.revision }, { fromPaused: true });
    assert.equal(resumed.activation, "armed");
    const after = await waitFor(async () => {
      const v = await h.goals.get(h.session.id);
      return v.goal.roundsStarted > resumed.goal.roundsStarted ? v : null;
    });
    assert.equal(after.activation, "armed");
  } finally {
    await h.close();
  }
});

test("a queued human input opens its own turn and no round preempts it", async () => {
  // A source never takes a queued human input's place: with a human input
  // already queued, the runtime opens that input as the turn.
  const h = await createHarness({ script: () => reply("ok") });
  try {
    const live = await h.openSession();
    live.enqueue({ content: "human next", source: "user" });
    await h.goals.create(h.session.id, { objective: "human first", maxGoalRounds: 10 });
    await h.agent.chat({ sessionId: h.session.id, messages: [{ role: "user", content: "typed" }] });
    const users = h.requests[0].filter((m) => m.role === "user").map((m) => String(m.content));
    assert.ok(users.includes("human next"), "the queued human input opens the turn");
    assert.ok(!users.some((text) => text.startsWith("<goal_round>")), "no round preempts the human");
  } finally {
    await h.close();
  }
});
