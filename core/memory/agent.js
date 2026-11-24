"use strict";

// Agent: one session's runtime instance. Cross-turn resident; created lazily by
// AgentRegistry and kept until the session is hard-deleted or the process exits.
//
// Construction is three-part (docs/agents/agent-instance.md §4):
//   1. SharedServices  — injected references, identical for every instance
//   2. AgentState      — the explicit initial-value list of instance state
//   3. Agent           — this class: the state plus behaviour methods
//
// State ownership (docs/agents/agent-instance.md §2):
//   session facts      -> store (never cached here)
//   instance runtime   -> phase / inbox / planMode / todos
//   per-turn delivery  -> turn (non-null inside a turn, null between turns)
//   process gates      -> the process container, read-only from here
//
// bare mode (persist=false) uses an unregistered instance: sessionId=null, the
// inbox lives only for the call, and it never takes the cursor.

import crypto from "crypto";
import { createTurnState } from "./turn-state.js";

class Agent {
  constructor({ sessionId = null, kind = "normal", parentSessionId = null, agentName = "lead", persist = false, shared = {}, gates = {} } = {}) {
    // Identity: read-only, from store.
    this.sessionId = sessionId;
    this.kind = kind;
    this.parentSessionId = parentSessionId;
    this.agentName = agentName;
    this.persist = persist === true;

    // Shared services (segment 1).
    this.shared = shared;
    this.config = shared.config || null;
    this.model = shared.model || null;
    this.context = shared.context || null;
    this.tools = shared.tools || null;
    this.skills = shared.skills || null;
    this.store = shared.store || null;
    this.goals = shared.goals || null;
    this.subagents = shared.subagents || null;
    this.interactions = shared.interactions || null;

    // Process gates: `activeSessions` / `compacting` / `bootId` live in the
    // container and outlive a turn; the instance only reads them.
    this.gates = gates;

    // Runtime state (segment 2).
    this.phase = { kind: "idle" };
    this.inbox = { nextTurn: [], nextStep: [] };
    this.planMode = {
      active: false,
      pendingExit: false,
      lastHeaderActive: undefined,
      notices: [],
    };
    this.todos = [];

    // Per-turn delivery state: non-null inside a turn, nulled at turn end.
    this.turn = null;

    this._idleWaiters = [];
  }

  // ---- identity ----
  get key() {
    return this.sessionId == null ? "__bare__" : String(this.sessionId);
  }

  running() {
    return this.phase.kind === "running";
  }

  // ---- turn lifecycle ----

  // Open one turn. The caller owns the body; this only flips phase, installs
  // the delivery state and guarantees the turn ends exactly once.
  // Returns { turn, abort, finish(payload) } and runs `body(turn)` if given.
  beginTurn({ emit = () => {}, autonomy = "supervised", effort = null, activity = "bare-chat", interactions = null } = {}) {
    if (this.running()) throw new Error("session " + this.key + " is already running a turn");
    const abort = new AbortController();
    const turn = createTurnState({
      emit,
      autonomy: autonomy === "autonomous" ? "autonomous" : "supervised",
      effort: effort && effort !== "undefined" ? effort : null,
      activity: activity === "plan-mode" ? "plan-mode" : (activity || "bare-chat"),
      interactions,
    });
    this.turn = turn;
    this.phase = { kind: "running", abort };
    return {
      turn,
      abort,
      signal: abort.signal,
      finish: () => this._finishTurn(),
    };
  }

  _finishTurn() {
    this.turn = null;
    this.phase = { kind: "idle" };
    const waiters = this._idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  // ---- inbox ----

  // Enqueue an input. `target` is "next-turn" | "next-step". Delivery never
  // rejects a busy target: busy only changes which queue the message lands in
  // (docs/agents/inbox.md §7). Returns the queue it landed in.
  enqueue(message, target = "next-turn") {
    const item = {
      id: message.id != null ? message.id : crypto.randomUUID(),
      content: message.content,
      source: message.source != null ? message.source : "user_input",
    };
    const wantStep = target === "next-step";
    // No step is in flight, so a next-step input has nowhere to land: it waits
    // for the next turn instead.
    if (wantStep && this.running()) {
      this.inbox.nextStep.push(item);
      return "next-step";
    }
    this.inbox.nextTurn.push(item);
    return "next-turn";
  }

  claimNextTurn() {
    return this.inbox.nextTurn.shift() || null;
  }

  claimNextStep() {
    const items = this.inbox.nextStep.splice(0);
    return items;
  }

  hasPending() {
    return this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0;
  }

  // ---- control ----

  // Abort the current turn, keep the inbox and anything already delivered.
  interrupt() {
    if (!this.running()) return false;
    this.phase.abort.abort();
    return true;
  }

  // Resolves after the current turn ends (immediately when idle).
  whenIdle() {
    if (!this.running()) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  // ---- plan mode (pure state; the core node decides when to run it) ----

  planPolicyActive() {
    return this.planMode.active === true;
  }

  // Flip plan mode. Returns the new value. A switch narrates itself through a
  // deferred notice when it crosses the value the previous header observed.
  setPlanMode(active) {
    const target = active === true;
    const changed = this.planMode.active !== target;
    this.planMode.active = target;
    const prev = this.planMode.lastHeaderActive;
    if (changed && prev !== undefined && prev !== target) {
      this.planMode.notices.push(
        target
          ? "The user switched this session to plan mode."
          : "The user switched this session back to the default mode.",
      );
      this.planMode.lastHeaderActive = target;
    } else {
      this.planMode.lastHeaderActive = target;
    }
    return target;
  }

  recordHeaderPlanMode() {
    const prev = this.planMode.lastHeaderActive;
    this.planMode.lastHeaderActive = this.planMode.active;
    return prev !== this.planMode.active;
  }

  clearPlanMode() {
    this.planMode.active = false;
    this.planMode.pendingExit = false;
    this.planMode.lastHeaderActive = undefined;
    this.planMode.notices.length = 0;
  }

  requestPlanExit() {
    if (!this.planMode.active) return false;
    this.planMode.pendingExit = true;
    return true;
  }

  applyPlanExit() {
    if (!this.planMode.pendingExit) return false;
    this.planMode.pendingExit = false;
    this.planMode.active = false;
    return true;
  }

  takePlanNotices() {
    return this.planMode.notices.splice(0);
  }

  // ---- todos (turn-scoped projection) ----

  setTodos(list) {
    this.todos = Array.isArray(list) ? list : [];
    return this.todos;
  }

  resetTodos() {
    this.todos = [];
  }
}

const __exports = { Agent };
export { Agent };
export default __exports;
