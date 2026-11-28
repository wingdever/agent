"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import { applyInteraction } from "../../lib/channel-interactions/index.js";

function coreWith(overrides = {}) {
  return {
    interactions: {
      approve: () => true,
      answerQuestions: () => true,
      answerPlanReview: () => true,
      ...overrides,
    },
  };
}

test("approval, question and plan-review callbacks reach core.interactions", () => {
  const calls = [];
  const core = coreWith({
    approve: (id, decision) => { calls.push(["approve", id, decision]); return true; },
    answerQuestions: (id, answers) => { calls.push(["answers", id, answers]); return true; },
    answerPlanReview: (id, review) => { calls.push(["plan", id, review]); return true; },
  });
  applyInteraction(core, { kind: "approval", id: 1, decision: "deny" });
  applyInteraction(core, { kind: "question", id: 2, answers: [["q", "a"]] });
  applyInteraction(core, { kind: "plan-review", id: 3, approved: true, feedback: "ok" });
  assert.deepEqual(calls, [
    ["approve", 1, "deny"],
    ["answers", 2, [["q", "a"]]],
    ["plan", 3, { approved: true, feedback: "ok" }],
  ]);
});

test("a stale callback fails loudly instead of being ignored", () => {
  const core = coreWith({ approve: () => false });
  assert.throws(() => applyInteraction(core, { kind: "approval", id: 9, decision: "approve" }), /no longer pending/);
  assert.throws(() => applyInteraction(core, { kind: "unknown", id: 1 }), /unknown interaction kind/);
  assert.throws(() => applyInteraction(core, { kind: "approval" }), /id is missing/);
});
