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

    // Pause marker (docs/runtime/turn-pause.md §2.2). `requested` is an intent
    // that takes effect at the next pause point; `active` means the turn is
    // stopped and waiting to be continued. Both are process-local.
    this.pause = { requested: false, active: false, node: null, pausedAt: null, resolve: null, step: null, continueAt: null, awaiting: false };

    this._idleWaiters = [];
    // wait_agent marks messages it has reported without consuming them; the
    // step boundary clears the set when it claims nextStep.
    this.nextStepReported = new Set();
    this._stepWaiters = [];

    // Turn lifecycle events (docs/agents/lifecycle.md §1). Listeners are
    // synchronous and their return values are ignored: a feature that needs
    // asynchronous work runs its own queue. `started` remembers whether the
    // one-time session:start edge has been delivered.
    this._listeners = new Map();
    this._sessionStarted = !(this.persist === true && this.sessionId != null);
  }

  // ---- events ----

  // Subscribe to one lifecycle event. Returns the unsubscribe function.
  //   session:start  { agent }
  //   turn:start     { agent, turn }
  //   turn:end       { agent, status, reason, steps, tools, durationMs, claim }
  //   turn:paused    { agent, pausedAt, pending }
  //   turn:resumed   { agent }
  //   turn:cancelled { agent, cause }
  //   inbox:queued | inbox:claimed | inbox:removed  { agent, queue, item }
  on(event, fn) {
    if (typeof fn !== "function" || typeof event !== "string") return () => {};
    const set = this._listeners.get(event) || new Set();
    set.add(fn);
    this._listeners.set(event, set);
    return () => {
      const current = this._listeners.get(event);
      if (!current) return;
      current.delete(fn);
      if (!current.size) this._listeners.delete(event);
    };
  }

  // The session-start edge: an overridable hook that dispatches session:start.
  _onSessionStart(turn) {
    this._emit("session:start", { turn });
  }

  // Deliver one event synchronously. A listener that throws never breaks the
  // turn: the failure is logged and the remaining listeners still run.
  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try {
        fn({ agent: this, ...payload });
      } catch (error) {
        console.warn("[agent] " + event + " listener failed for session " + this.key + ": " + ((error && error.message) || error));
      }
    }
  }

  // ---- identity ----
  get key() {
    return this.sessionId == null ? "__bare__" : String(this.sessionId);
  }

  running() {
    return this.phase.kind === "running";
  }

  // A turn is alive: executing, or stopped at a pause point waiting to be
  // continued (docs/runtime/turn-pause.md §2.1). Every "is this session busy"
  // decision uses this, never running().
  inTurn() {
    return this.phase.kind === "running" || this.phase.kind === "paused";
  }

  // ---- turn lifecycle ----

  // Open one turn. The caller owns the body; this only flips phase, installs
  // the delivery state and guarantees the turn ends exactly once.
  // Returns { turn, abort, finish(outcome) }.
  // `claim` is opaque to the instance: the turn source that opened this turn
  // puts it there and the loop persists it at the turn's first step (the
  // lifecycle contract, docs/agents/lifecycle.md §1.3).
  // `continuing` adopts a turn row that already exists (a turn continued after
  // a pause): the row is carried, turn-start does not run, and no new turn is
  // opened (docs/runtime/turn-pause.md §4.5).
  beginTurn({ emit = () => {}, autonomy = "supervised", effort = null, activity = "bare-chat", interactions = null, claim = null, firstTurn = false, continuing = null } = {}) {
    if (this.inTurn()) throw new Error("session " + this.key + " is already running a turn");
    const abort = new AbortController();
    const turn = createTurnState({
      emit,
      autonomy: autonomy === "autonomous" ? "autonomous" : "supervised",
      effort: effort && effort !== "undefined" ? effort : null,
      activity: activity === "plan-mode" ? "plan-mode" : (activity || "bare-chat"),
      interactions,
    });
    turn.claim = claim != null ? claim : null;
    turn.deferred = [];
    if (continuing) {
      turn.row = continuing.row || null;
      if (continuing.stepSeq != null) turn.stepSeq = continuing.stepSeq;
    }
    // The session-start edge fires once, before the first turn that starts a
    // session, and never for a turn a turn source opens (a source only
    // continues a live session). The event is shaped through `_onSessionStart`
    // so a composite can wrap it.
    if (!this._sessionStarted && claim == null && !continuing) {
      this._sessionStarted = true;
      this._onSessionStart(turn);
    }
    this.turn = turn;
    this.phase = { kind: "running", abort };
    this._emit("turn:start", { turn });
    return {
      turn,
      abort,
      signal: abort.signal,
      finish: (outcome) => this.finishTurn(outcome),
    };
  }

  // Close the turn. `outcome` carries the loop's terminal facts; it is merged
  // into the turn:end payload (docs/agents/lifecycle.md §1.2).
  finishTurn(outcome = {}) {
    const turn = this.turn;
    this.turn = null;
    this.phase = { kind: "idle" };
    this._resetPause();
    const waiters = this._idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
    // Listeners run before the turn's caller resumes, so a source that
    // schedules the next turn sees every turn end exactly once.
    this._emit("turn:end", {
      status: outcome.status || "succeeded",
      reason: outcome.reason || "no-tool-calls",
      steps: outcome.steps || 0,
      tools: outcome.tools || 0,
      durationMs: outcome.durationMs || 0,
      claim: turn ? turn.claim : null,
    });
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
    if (wantStep && this.inTurn()) {
      this.inbox.nextStep.push(item);
      this._notifyStepWaiters();
      this._emit("inbox:queued", { queue: "next-step", item });
      return "next-step";
    }
    this.inbox.nextTurn.push(item);
    this._emit("inbox:queued", { queue: "next-turn", item });
    return "next-turn";
  }

  claimNextTurn() {
    const item = this.inbox.nextTurn.shift() || null;
    if (item) this._emit("inbox:claimed", { queue: "next-turn", item });
    return item;
  }

  peekNextTurn() {
    return this.inbox.nextTurn.slice();
  }

  // Remove one queued input by id (any queue). Returns the removed item, or
  // null when it was not queued.
  removeFromInbox(id) {
    for (const [name, queue] of [["next-turn", this.inbox.nextTurn], ["next-step", this.inbox.nextStep]]) {
      const index = queue.findIndex((item) => item.id === id);
      if (index < 0) continue;
      const [item] = queue.splice(index, 1);
      this._emit("inbox:removed", { queue: name, item });
      return item;
    }
    return null;
  }

  // Put an item back at the tail of the next-turn queue (a reservation that
  // must yield to an input which arrived first).
  requeueNextTurn(item) {
    this.inbox.nextTurn.push(item);
    this._emit("inbox:queued", { queue: "next-turn", item });
    return "next-turn";
  }

  claimNextStep() {
    const items = this.inbox.nextStep.splice(0);
    this.nextStepReported.clear();
    for (const item of items) this._emit("inbox:claimed", { queue: "next-step", item });
    return items;
  }

  peekNextStep() {
    return this.inbox.nextStep.slice();
  }

  unreportedNextStep() {
    return this.inbox.nextStep.filter((item) => !this.nextStepReported.has(item.id));
  }

  markNextStepReported(ids) {
    for (const id of ids || []) this.nextStepReported.add(id);
  }

  // Resolve when nextStep changes, the timeout expires, or the turn aborts.
  // The caller re-checks unreportedNextStep() after each wakeup.
  _waitForStepSignal(timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const index = this._stepWaiters.indexOf(finish);
        if (index >= 0) this._stepWaiters.splice(index, 1);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const index = this._stepWaiters.indexOf(finish);
        if (index >= 0) this._stepWaiters.splice(index, 1);
        reject(new Error("tool call aborted"));
      };
      this._stepWaiters.push(finish);
      timer = setTimeout(finish, Math.max(0, timeoutMs));
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async waitForNextStep({ timeoutMs = 30000, signal } = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const pending = this.unreportedNextStep();
      if (pending.length > 0) return pending;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this._waitForStepSignal(Math.min(remaining, 250), signal);
    }
  }

  _notifyStepWaiters() {
    const waiters = this._stepWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  hasPending() {
    return this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0;
  }

  // ---- control ----

  // ---- pause (docs/runtime/turn-pause.md §3.1) ----

  // Ask the current turn to stop at its next pause point. An intent only: it
  // is honoured at `before-tools` / `before-model`, never by interrupting a
  // model request or a running tool.
  requestPause() {
    if (!this.inTurn()) return false;
    if (this.pause.requested || this.pause.active) return true;
    this.pause.requested = true;
    return true;
  }

  // The pause point reached. Called by the loop; blocks until continued.
  // `pausedAt` is "before-tools" or "before-model".
  async pauseAt(pausedAt) {
    if (!this.inTurn()) return false;
    this.pause.requested = false;
    this.pause.active = true;
    this.pause.pausedAt = pausedAt;
    this.pause.node = pausedAt === "before-tools" ? "tool-execute" : "model-call";
    // Which turn/step this pause belongs to: enough to continue it after a
    // restart without opening a new turn.
    this.pause.step = this.turn
      ? { turnRow: this.turn.row || null, step: this._pauseStep || null }
      : null;
    // The continue cursor: which stored step the turn stopped on. It survives
    // the rest of the pause bookkeeping so a restart can pick the step up.
    this.pause.continueAt = this.pause.step ? { pausedAt, step: this.pause.step } : null;
    // A pause reached by a live loop keeps that loop suspended here; a pause
    // restored from a snapshot has no loop behind it.
    this.pause.awaiting = true;
    const abort = this.phase.abort;
    this.phase = { kind: "paused", abort };
    // A paused turn is not continuable automatically: stop goal rounds now.
    if (this.goals && typeof this.goals.disarm === "function" && this.sessionId != null) {
      try { this.goals.disarm(this.sessionId); } catch (_) { /* activation is advisory */ }
    }
    this._emit("turn:paused", { pausedAt, pending: this.pausedPending() });
    // One exit only: this gate is opened by a continue or by a cancellation.
    await new Promise((resolve) => { this.pause.resolve = resolve; });
    return true;
  }

  // Continue a paused turn from its pause point. The steer message, when
  // given, waits for the next step boundary like any other next-step input.
  resumeTurn({ message = null } = {}) {
    if (this.phase.kind !== "paused") return false;
    if (message && String(message.content || "").trim()) {
      this.enqueue({ content: message.content, source: message.source || "user_input" }, "next-step");
    }
    // A restore-only pause has no loop waiting on it: keep `continueAt` so the
    // caller can start the resumed turn.
    const restored = this.pause.continueAt != null && this.pause.awaiting !== true;
    // The restored step's rows are what a continue runs; keep them.
    const continuing = this.pause.continueAt;
    const abort = this.phase.abort;
    this.pause.requested = false;
    this.pause.active = false;
    this.pause.pausedAt = null;
    this.pause.node = null;
    const resolve = this.pause.resolve;
    this.pause.resolve = null;
    if (restored) {
      // The resumed loop opens the turn itself (beginTurn inside resumeLoop).
      this.phase = { kind: "idle" };
      this.pause.continueAt = continuing; // the caller consumes it
    } else {
      // A live loop is suspended on this pause: release it where it stopped.
      this.pause.continueAt = null;
      this.phase = { kind: "running", abort };
      if (resolve) resolve();
    }
    this._emit("turn:resumed", {});
    return true;
  }

  // What the pause card lists besides the pause point. At `before-tools` the
  // card lists the pending tool calls; at `before-model` there are none, so the
  // card only names the next node.
  pausedPending() {
    // Pending calls live in `calls` (the turn's step state), not here; the
    // service layer reads them for `turn.state`.
    return [];
  }

  // The pause fact for a snapshot, or null when this session is not paused.
  snapshotPause() {
    if (this.phase.kind !== "paused" || !this.pause.active) return null;
    return {
      state: "paused",
      pausedAt: this.pause.pausedAt,
      // The steps already past their pause point; the restore path continues
      // them instead of running the loop from turn-start (which would open a
      // second turn for the same session).
      continueAt: this.pause.continueAt,
      // Only unclaimed entries are worth restoring; a claimed list is already
      // in the step that will persist it (docs/runtime/turn-pause.md §5).
      nextStep: this.inbox.nextStep.map((item) => ({ id: item.id, content: item.content, source: item.source })),
    };
  }

  // Restore a pause read back from a snapshot (or inferred from the store).
  // The instance has no running turn yet: the phase goes straight to paused
  // and the restored inputs rejoin the next-step queue.
  // `continueAt` names the steps already opened in the stored turn; a paused
  // instance continues those, on top of the turn, turn-start never re-runs.
  restorePause({ pausedAt, nextStep = [], continueAt = null } = {}) {
    if (this.sessionId == null) return false;
    this.pause.requested = false;
    this.pause.active = true;
    this.pause.pausedAt = pausedAt === "before-model" ? "before-model" : "before-tools";
    this.pause.node = this.pause.pausedAt === "before-tools" ? "tool-execute" : "model-call";
    this.pause.continueAt = continueAt && continueAt.step
      ? { pausedAt: continueAt.pausedAt || this.pause.pausedAt, step: continueAt.step }
      : null;
    // Nobody is suspended on this pause: it was rebuilt from a snapshot.
    this.pause.awaiting = false;
    this.phase = { kind: "paused", abort: new AbortController() };
    for (const item of nextStep) {
      if (!item || typeof item.content !== "string") continue;
      this.inbox.nextStep.push({
        id: item.id != null ? item.id : crypto.randomUUID(),
        content: item.content,
        source: item.source || "user_input",
      });
    }
    return true;
  }

  _resetPause() {
    this.pause.requested = false;
    this.pause.active = false;
    this.pause.pausedAt = null;
    this.pause.node = null;
    this.pause.step = null;
    this._pauseStep = null;
    this.pause.continueAt = null;
    this.pause.awaiting = false;
    const resolve = this.pause.resolve;
    this.pause.resolve = null;
    if (resolve) resolve();
  }

  // Abort the current turn, keep the inbox and anything already delivered.
  // `reason` is the turn-end reason this cancellation produces (an aborted
  // model request, or the loop's own "interrupted" at a step boundary). It is
  // kept beside the controller so the loop can report it in [turn]/turn-end.
  interrupt(reason = "model-request-error", cause = null) {
    if (!this.inTurn()) return false;
    this.phase.cancelReason = reason;
    this.phase.abort.abort();
    // A turn stopped at a pause point is waiting on the gate, not on the
    // request: release it so the loop can report the cancellation.
    const gate = this.pause.resolve;
    this.pause.resolve = null;
    if (gate) gate();
    this._emit("turn:cancelled", { reason, cause });
    return true;
  }

  // Resolves after the current turn ends (immediately when idle).
  whenIdle() {
    if (!this.inTurn()) return Promise.resolve();
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
