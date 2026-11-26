"use strict";

// Shared execution for get_goal / create_goal / update_goal (docs/agents/goal.md
// §3-§4). The three registries carry the model-facing description, schema and
// prompt section; this module owns the result shape so the three tools cannot
// drift apart.
//
// There is no caller authorization here: GoalService owns the phase machine,
// exact-ref CAS and activation switch, and accepts a mutation from any tool
// caller. The only goal-round distinction is a lifecycle fact read from
// `turn.claim.goalRound`; it selects the blocked threshold and the closing
// instruction, never a permission.
//
// The result is the canonical compact JSON `{ goal, activation }`; failures are
// `Error: <message>` through the tool executor's error path.

const BLOCKED_AFTER_DEFAULT = 3;

// The blocked threshold lives on the goal toolpack (docs/tools/toolpack.md):
// the same value feeds the prompt section's placeholder and this check, so the
// model is never told a number the execution path would reject.
function blockedAfter(exec) {
  const pack = exec && exec.tool ? exec.tool.package : null;
  const value = pack && pack.promptVars ? pack.promptVars.blockedAfterConsecutiveRounds : undefined;
  return Number.isSafeInteger(value) && value > 0 ? value : BLOCKED_AFTER_DEFAULT;
}

// The goal-round lifecycle marker: set by GoalRoundDriver on the turn's claim.
// It is not identity and not a source check; it only says this turn was opened
// by the continuation driver for the current goal.
function goalRoundClaim(exec) {
  const agent = exec && exec.agent;
  const claim = agent && agent.turn ? agent.turn.claim : null;
  return claim && claim.goalRound ? claim.goalRound : null;
}

// Context the tool executor must provide: goals, agent.
function goalService(exec) {
  if (!exec.goals) throw new Error("goal tools require the goal service");
  return exec.goals;
}

async function context(exec) {
  const goals = goalService(exec);
  if (!exec.agent) throw new Error("goal tools require a calling agent");
  const agent = exec.agent;
  if (agent.sessionId == null) throw new Error("goal tools require a persisted session");
  const goal = await goals.get(agent.sessionId);
  return { goals, agent, goal };
}

function shaped(value) {
  return { text: JSON.stringify(value), meta: value };
}

function hasText(value) {
  return typeof value === "string" && value !== "" && value.trim() !== "";
}

function hasRoundCap(value) {
  return value !== undefined && value !== null && value !== 0;
}

// ---- get_goal ----

async function getGoal(args, exec) {
  const ctx = await context(exec);
  return shaped(await ctx.goals.get(ctx.agent.sessionId));
}

// ---- create_goal ----

async function createGoal(args = {}, exec) {
  const ctx = await context(exec);
  const value = await ctx.goals.create(ctx.agent.sessionId, {
    objective: args.objective,
    maxGoalRounds: args.max_goal_rounds,
  });
  return shaped(value);
}

// ---- update_goal ----

async function updateGoal(args = {}, exec) {
  const ctx = await context(exec);
  const { agent, goals, goal } = ctx;
  const sessionId = agent.sessionId;
  const action = args.action;
  const ref = { id: args.goal_id, revision: args.revision };
  const roundClaim = goalRoundClaim(exec);

  if (action === "complete" || action === "blocked") {
    if (action === "blocked") {
      if (!hasText(args.blocked_reason)) throw new Error("blocked_reason is required with action blocked");
      const current = goal && goal.goal;
      const threshold = blockedAfter(exec);
      if (roundClaim && current && current.roundsStarted < threshold) {
        throw new Error(
          "blocked requires at least " + threshold + " consecutive goal rounds; current round is " + current.roundsStarted,
        );
      }
      const value = await goals.block(sessionId, ref, { code: "model-reported", message: args.blocked_reason });
      if (roundClaim) deferWrapup(exec, "blocked", value, args.blocked_reason);
      return shaped(value);
    }
    const value = await goals.complete(sessionId, ref);
    if (roundClaim) deferWrapup(exec, "complete", value);
    return shaped(value);
  }

  // edit / pause / resume: GoalService enforces phase, ref and budget rules.
  switch (action) {
    case "edit": {
      const objective = hasText(args.objective) ? args.objective : undefined;
      const cap = hasRoundCap(args.max_goal_rounds) ? args.max_goal_rounds : undefined;
      if (objective === undefined && cap === undefined) {
        throw new Error("goal edit requires objective and/or max_goal_rounds");
      }
      return shaped(await goals.edit(sessionId, ref, { objective, maxGoalRounds: cap }));
    }
    case "pause":
      return shaped(await goals.pause(sessionId, ref));
    case "resume":
      // The tool path never resumes a durable paused goal; that belongs to the
      // human control surface (goal.resume RPC).
      return shaped(await goals.resume(sessionId, ref, { fromPaused: false }));
    default:
      throw new Error('unknown goal action "' + String(action) + '"');
  }
}

// Terminal goal-round updates close the autonomous run: the model gets one
// closing instruction before the turn ends (DSH renderWrapupContext).
function deferWrapup(exec, kind, value, blockedReason) {
  if (typeof exec.deferContext !== "function") return;
  const objective = value && value.goal ? value.goal.objective : "";
  const heading = "Objective: " + JSON.stringify(objective) + "\n";
  const text = kind === "blocked"
    ? "<goal_blocked>\n" + heading + "Blocked: " + JSON.stringify(blockedReason) +
      "\nThe goal is marked blocked and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue. Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_blocked>"
    : "<goal_complete>\n" + heading +
      "The goal is marked complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Note anything the user should review or do next. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_complete>";
  exec.deferContext(text);
}

const __exports = { getGoal, createGoal, updateGoal, blockedAfter };
export { getGoal, createGoal, updateGoal, blockedAfter };
export default __exports;
