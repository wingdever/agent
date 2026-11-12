"use strict";

// Per-session plan mode. DSH logs plan mode as session state; this dev build
// keeps it in memory (page reload keeps the core process, app restart resets).
// While active, chat() appends POLICY to the system message for every request.
//
// Pending exit: DSH defers the mode flip to the next in-turn pre-step so the
// rest of the assistant's current tool batch stays under plan guidance. We keep
// the same contract with an in-memory pending map: an approved exit sets
// `pendingExit` instead of leaving immediately; the loop clears it at the top of
// the next step, which is where requestSystem is recomputed. The UI is told to
// leave at approval time (broadcast plan-mode=false) for responsiveness, while
// `isActive` keeps reporting true until the pending flip so in-batch tools still
// carry POLICY.

const POLICY = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`;

const states = new Map();
const pendingExits = new Map();
// Last plan-active value observed by a request header for each session. Mirrors
// DSH's `activeAtLastHeader`: a switch notice is emitted only when the state a
// request will observe differs from the one the previous request observed, so
// the model is told exactly when its context changed and never redundantly.
const lastHeaderActive = new Map();
// Switch notices decided at setActive time but deferred to request assembly,
// where conv (and the store, when persisted) is available to append them.
const pendingNotices = new Map();

function keyFor(sessionId) {
  return sessionId == null || sessionId === "" ? null : String(sessionId);
}

function isActive(sessionId) {
  const key = keyFor(sessionId);
  return key === null ? false : states.get(key) === true;
}

function getLastHeaderActive(sessionId) {
  const key = keyFor(sessionId);
  return key === null ? undefined : lastHeaderActive.get(key);
}

// Record the plan-active value a request header will observe. Call once per step
// before the request is derived. Returns true when the observed state changed
// since the previous header, so the caller can flush any deferred notice.
function recordHeader(sessionId, active) {
  const key = keyFor(sessionId);
  if (key === null) return false;
  const prev = lastHeaderActive.get(key);
  lastHeaderActive.set(key, active === true);
  return prev !== (active === true);
}

function setActive(sessionId, active) {
  const key = keyFor(sessionId);
  if (key === null) return false;
  const target = active === true;
  const changed = states.get(key) === true !== target;
  if (target) {
    states.set(key, true);
  } else {
    states.delete(key);
  }
  pendingExits.delete(key);
  // A user-initiated switch (activity/UI) narrates the transition: decide the
  // notice now (deferred to request assembly) when the logged state crosses the
  // boundary the previous header observed. An undefined header means first
  // contact, so no notice — the policy section itself conveys the initial state.
  const prevHeader = getLastHeaderActive(sessionId);
  if (changed && prevHeader !== undefined && prevHeader !== target) {
    const text = target
      ? "The user switched this session to plan mode."
      : "The user switched this session back to the default mode.";
    lastHeaderActive.set(key, target);
    const notices = pendingNotices.get(key) || [];
    notices.push(text);
    pendingNotices.set(key, notices);
  } else {
    lastHeaderActive.set(key, target);
  }
  return target;
}

// Drain deferred switch notices for a session. The caller appends each to the
// request conv (and persists it, when a store is present) before deriving the
// request, so the model sees the notice exactly when its context changes.
function takeNotices(sessionId) {
  const key = keyFor(sessionId);
  if (key === null) return [];
  const notices = pendingNotices.get(key) || [];
  pendingNotices.delete(key);
  return notices;
}

// An approved exit is deferred: mark pending rather than leaving now, so the
// rest of the current tool batch stays under plan guidance. Returns true when a
// pending exit was newly recorded.
function requestExit(sessionId) {
  const key = keyFor(sessionId);
  if (key === null) return false;
  if (states.get(key) !== true) return false;
  pendingExits.set(key, true);
  return true;
}

// Apply a pending exit at the top of the next step (DSH's next in-turn
// pre-step). Returns true when an exit was actually applied.
function applyPendingExit(sessionId) {
  const key = keyFor(sessionId);
  if (key === null) return false;
  if (!pendingExits.get(key)) return false;
  pendingExits.delete(key);
  states.delete(key);
  return true;
}

function hasPendingExit(sessionId) {
  const key = keyFor(sessionId);
  return key === null ? false : pendingExits.get(key) === true;
}

function clear(sessionId) {
  const key = keyFor(sessionId);
  if (key === null) {
    states.clear();
    pendingExits.clear();
    lastHeaderActive.clear();
    pendingNotices.clear();
  } else {
    states.delete(key);
    pendingExits.delete(key);
    lastHeaderActive.delete(key);
    pendingNotices.delete(key);
  }
}

module.exports = {
  POLICY,
  isActive,
  getLastHeaderActive,
  recordHeader,
  setActive,
  requestExit,
  applyPendingExit,
  hasPendingExit,
  takeNotices,
  clear,
};
