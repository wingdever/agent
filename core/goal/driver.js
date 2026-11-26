"use strict";

// Goal round driver (docs/agents/goal.md §6, §11): the same-session
// continuation loop, built entirely on the generic turn lifecycle interfaces
// (docs/agents/lifecycle.md):
//
//   - it registers as a turn source: `registerTurnSource({ name: "goal", admit })`
//   - it listens to instance events: session:start, turn:end, turn:cancelled,
//     inbox:queued, inbox:removed
//   - it hands the loop a claim through the admitted turn (`turn.claim`), which
//     model-call persists at the turn's first step
//
// It drives a live idle instance whose goal is active and armed, and only after
// every still-running descendant has settled. `armed` is granted solely by the
// goal service's `resume`; a session-start edge disarms the goal first, so a
// restart never continues on its own (goal.md §7).
//
// Round lifecycle (reservation → admission):
//   queued    — the <goal_round> prompt sits in the instance inbox
//   claimed   — admit() took it and the runtime opened the turn with it
//   admitted  — turn.claim.accept() persisted the round row
//   cancelled — removed before a turn consumed it
//   stale     — superseded by a newer goal revision or a competing input
//
// A reserved round that never reaches admission consumes no round number.
//
// Stop policy (goal.md §6.4), applied at turn end:
//   truncated                              → disarm, keep the goal active
//   cancelled while a goal round in flight  → pause the goal
//   cancelled with no goal round in flight  → disarm only
//   any other failure                      → disarm (never retried by the driver)
//   round cap exhausted                    → block "round-limit"
//   queue / admission failed               → block "queue-failed" / "prompt-rejected"

import { randomUUID } from "node:crypto";

const SOURCE = "goal";
// The human scheduling source: a human input queued ahead of a reserved round
// takes the next turn first. This is queue priority, not goal authorization.
const HUMAN_SOURCE = "user";

// The retained continuation prompt: envelope, field order and wording follow
// DSH (dsh-goal-round-driver renderGoalRoundPrompt).
function renderGoalRoundPrompt(goal, round) {
  return [
    "<goal_round>",
    "Objective: " + JSON.stringify(goal.objective),
    "Round: " + round + "/" + goal.maxGoalRounds,
    "",
    "Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.",
    "</goal_round>",
  ].join("\n");
}

function renderThrown(value) {
  return value instanceof Error ? value.message : String(value);
}

function refOf(view) {
  return { id: view.goal.id, revision: view.goal.revision };
}

class GoalRoundDriver {
  /**
   * @param {object} deps
   * @param {object} deps.goals             GoalService
   * @param {object} deps.runtime           AgentRuntime (turn sources + chat)
   * @param {Function} [deps.getSubagents]  () => SubagentRuntime | null
   * @param {object} [deps.logger]
   */
  constructor({ goals, runtime, getSubagents = () => null, logger = console } = {}) {
    if (!goals) throw new Error("GoalRoundDriver requires the goal service");
    if (!runtime) throw new Error("GoalRoundDriver requires the agent runtime");
    this.goals = goals;
    this.runtime = runtime;
    this.registry = runtime.registry;
    this.getSubagents = getSubagents;
    this.logger = logger;
    this.states = new Map(); // agent key -> state
    this.started = false;
    this.unloading = false;
    // Cancellations this driver asked for, so turn end can attribute them.
    this._cancelCause = new Map();
    this._unregisters = [];
  }

  // ---- lifecycle ----

  start() {
    if (this.started) return;
    this.started = true;
    // The driver is one turn source among any others; it never lets the
    // runtime know about goal beyond this registration.
    this._unregisters.push(this.runtime.registerTurnSource({
      name: "goal",
      priority: 0,
      admit: (agent) => this.admit(agent),
    }));
    for (const agent of this.registry.list()) this._stateFor(agent);
  }

  // Teardown: unregister, close admission, disarm live goals and cancel goal
  // rounds in flight. Never writes a revision.
  async unload() {
    this.unloading = true;
    for (const off of this._unregisters.splice(0)) {
      try { off(); } catch (_) { /* registry already gone */ }
    }
    const waits = [];
    for (const state of this.states.values()) {
      state.stopping = true;
      this._disarm(state);
      if (state.attempt) {
        state.attempt.stale = true;
        state.attempt = null;
        if (state.agent.running()) {
          this._cancel(state, "driven");
          waits.push(state.agent.whenIdle());
        }
      }
      for (const off of state.off) {
        try { off(); } catch (_) { /* instance gone */ }
      }
      state.off = [];
    }
    for (const wait of waits) {
      try { await wait; } catch (_) { /* best effort */ }
    }
    this.states.clear();
  }

  _stateFor(agent) {
    let state = this.states.get(agent.key);
    if (state && state.agent !== agent) {
      // The session was released and instantiated again (restart, reopen): the
      // old instance's listeners are dead with it. The driver state follows the
      // live instance; the reservation belonged to the old one and is dropped.
      for (const off of state.off) {
        try { off(); } catch (_) { /* instance gone */ }
      }
      state.off = [];
      state.agent = agent;
      state.attempt = null;
      state.competingQueued = false;
      state.cancelCause = null;
      state.pausedOnce = false;
    }
    if (state) {
      this._install(state);
      return state;
    }
    state = {
      agent,
      attempt: null,
      competingQueued: false,
      needsCheckpoint: false,
      stopping: false,
      run: null,
      requested: false,
      pausedOnce: false,
      cancelCause: null,
      off: [],
    };
    this.states.set(agent.key, state);
    this._install(state);
    return state;
  }

  // Subscribe the driver's listeners to one instance. Idempotent: the listeners
  // are stored on the state and installed once.
  _install(state) {
    const agent = state.agent;
    if (!agent || agent.persist !== true || agent.sessionId == null) return;
    if (typeof agent.on !== "function" || state.off.length) return;
    state.off = [
      agent.on("session:start", () => this._onSessionStart(state)),
      agent.on("turn:end", (payload) => this.onTurnEnd(state, payload)),
      agent.on("turn:cancelled", (payload) => {
        state.cancelCause = payload.cause || "other";
      }),
      agent.on("inbox:queued", (payload) => this.onInputQueued(state, payload)),
      agent.on("inbox:removed", (payload) => this.onInputRemoved(state, payload)),
    ];
  }

  // Drop one instance's driver state (its session was deleted).
  forget(agent) {
    if (agent) this.states.delete(agent.key);
  }

  // One consistent snapshot of the driver's view of a session, for the goal
  // status surface.
  describe(sessionId) {
    const agent = this.registry.get(sessionId);
    const state = agent ? this.states.get(agent.key) : null;
    if (!state) return null;
    return {
      reservation: state.attempt ? state.attempt.phase : null,
      round: state.attempt ? state.attempt.round : null,
      running: agent.running(),
      driving: !!state.run,
      competingInput: state.competingQueued,
    };
  }

  // ---- views ----

  _live(agent) {
    return this.registry.get(agent.sessionId) === agent;
  }

  async _view(state) {
    if (!this._live(state.agent)) return null;
    try {
      const view = await this.goals.get(state.agent.sessionId);
      if (!view || !view.goal) return null;
      return { ...view, activation: this.goals.activationOf(state.agent.sessionId) };
    } catch (error) {
      this.logger.warn("[goal-driver] goal read failed for session " + state.agent.key + ": " + renderThrown(error));
      return null;
    }
  }

  _drivable(view) {
    return view != null && view.goal != null && view.goal.phase === "active" && view.activation === "armed";
  }

  _disarm(state) {
    try {
      this.goals.disarm(state.agent.sessionId);
    } catch (error) {
      this.logger.warn("[goal-driver] disarm failed for session " + state.agent.key + ": " + renderThrown(error));
    }
  }

  _cancel(state, cause) {
    this._cancelCause.set(state.agent.key, cause);
    state.agent.interrupt("interrupted", cause);
  }

  // ---- events ----

  // A session-start edge disarms its goal: a restored or reopened session never
  // continues on its own (goal.md §7).
  _onSessionStart(state) {
    this._disarm(state);
  }

  // Goal service notification: change / round / activation.
  notify(event) {
    if (!event || event.sessionId == null) return;
    const agent = this.registry.get(event.sessionId);
    if (!agent) return;
    const state = this._stateFor(agent);
    if (event.type === "change") {
      state.needsCheckpoint = true;
      if (event.operation === "pause" && agent.running() && !this._cancelCause.has(agent.key)) {
        this._cancel(state, "human");
        return;
      }
    }
    if (event.type === "round") return;
    this._requestDrive(state);
  }

  // An input queued in front of the session. A human input always takes the
  // next turn; any other non-driver input makes automatic work yield.
  onInputQueued(state, payload) {
    if (!payload || payload.queue !== "next-turn") return;
    const item = payload.item;
    const attempt = state.attempt;
    if (attempt && item && item.id === attempt.messageId) return;
    state.competingQueued = true;
    if (attempt && attempt.phase === "queued") {
      if (item && item.source === HUMAN_SOURCE) this._pushReservationBack(state, attempt);
      else attempt.stale = true;
    }
    this._requestDrive(state);
  }

  // Put a reserved round back at the tail of the queue, behind an input that
  // just arrived, so the human's message is the next turn's first input.
  _pushReservationBack(state, attempt) {
    if (attempt.phase !== "queued") return;
    const agent = state.agent;
    const item = agent.removeFromInbox(attempt.messageId);
    if (!item) {
      attempt.phase = "cancelled";
      return;
    }
    attempt.phase = "queued";
    agent.requeueNextTurn(item);
  }

  onInputRemoved(state, payload) {
    if (!payload) return;
    const attempt = state.attempt;
    if (attempt && payload.item && payload.item.id === attempt.messageId) attempt.cancelled = true;
  }

  // A turn ended. Settle the reservation and apply the stop policy.
  onTurnEnd(state, payload = {}) {
    const attempt = state.attempt;
    state.attempt = null;
    state.competingQueued = false;
    const reason = payload.reason;
    const status = payload.status;

    if (status === "failed" && reason === "truncated") {
      this._disarm(state);
      this._requestDrive(state);
      return;
    }
    if (reason === "interrupted" || reason === "aborted") {
      state.cancelCause = null;
      if (attempt && (attempt.phase === "claimed" || attempt.phase === "admitted")) this._pause(state);
      else this._disarm(state);
      this._requestDrive(state);
      return;
    }
    if (reason === "claim-failed") {
      // The round was never counted; the source records the block and the
      // driver stops until the human resumes (goal.md §6.4).
      this._disarm(state);
      this._requestDrive(state);
      return;
    }
    if (status === "failed") this._disarm(state);
    this._requestDrive(state);
  }

  // ---- admission ----

  // The turn source. Called by the runtime when a session is idle (after a
  // queued human input has had its chance). Returns the reserved round and its
  // claim, or null when this session has nothing to continue.
  async admit(agent) {
    const state = this.states.get(agent.key);
    if (!state || this.unloading || state.stopping) return null;
    const attempt = state.attempt;
    if (!attempt || attempt.phase !== "queued" || attempt.stale) return null;
    const view = await this._view(state);
    const valid = view != null
      && view.goal.id === attempt.goalId
      && view.goal.revision === attempt.revision
      && view.goal.phase === "active"
      && view.activation === "armed"
      && attempt.round === view.goal.roundsStarted + 1;
    if (!valid) {
      attempt.stale = true;
      state.attempt = null;
      if (agent.removeFromInbox(attempt.messageId)) attempt.cancelled = true;
      if (!agent.hasPending()) this._requestDrive(state);
      return null;
    }
    // A human input queued before this round still takes the turn first.
    const head = agent.inbox.nextTurn[0];
    if (head && head.source === HUMAN_SOURCE && head.id !== attempt.messageId) {
      this._pushReservationBack(state, attempt);
      return null;
    }
    const item = agent.removeFromInbox(attempt.messageId);
    if (!item) {
      state.attempt = null;
      return null;
    }
    attempt.phase = "claimed";
    return {
      message: { content: item.content, source: SOURCE },
      claim: {
        goalRound: attempt,
        accept: () => this._accept(state, attempt),
        onStep: () => this._onStep(state, attempt),
      },
    };
  }

  // Persist the round row once. Called by model-call at the turn's first step,
  // after the opening input is durable and before the model request.
  async _accept(state, attempt) {
    if (attempt.accepted) return;
    try {
      await this.goals.admitRound(state.agent.sessionId, { id: attempt.goalId, revision: attempt.revision });
      attempt.phase = "admitted";
      attempt.accepted = true;
    } catch (error) {
      this.logger.warn("[goal-driver] could not admit round: " + renderThrown(error));
      if (state.attempt === attempt) state.attempt = null;
      const view = await this._view(state);
      if (this._drivable(view)) {
        try {
          await this.goals.block(state.agent.sessionId, refOf(view), {
            code: "prompt-rejected",
            message: "Goal round was rejected before entering its step: " + renderThrown(error),
          });
        } catch (err) {
          this.logger.warn("[goal-driver] could not record prompt-rejected: " + renderThrown(err));
        }
      }
      throw error;
    }
  }

  // A step boundary of the round: any other queued input means competing work.
  _onStep(state) {
    const agent = state.agent;
    const attempt = state.attempt;
    if (!agent || !attempt) return;
    const other = agent.inbox.nextTurn.some((item) => item.id !== attempt.messageId);
    if (other) state.competingQueued = true;
  }

  // ---- scheduling ----

  _requestDrive(state) {
    if (!state || !state.agent) return;
    if (this.unloading || state.stopping) return;
    state.requested = true;
    if (state.run) return;
    const run = (async () => {
      while (!state.stopping && !this.unloading) {
        state.requested = false;
        let productive = false;
        try {
          productive = await this._drive(state);
          // Settlement: an admitted round whose turn is over is settled here; a
          // running turn or someone else's queued input is settled by its turn
          // end, which asks for the next pass.
          const attempt = state.attempt;
          if (attempt && (attempt.phase === "cancelled" || attempt.phase === "stale")) state.attempt = null;
          if (state.attempt && state.attempt.phase === "admitted" && !state.agent.running()) {
            state.attempt = null;
            state.requested = true;
          }
          if (!state.agent.running() && !state.agent.hasPending()) state.competingQueued = false;
        } catch (error) {
          this.logger.warn("[goal-driver] drive failed for session " + state.agent.key + ": " + renderThrown(error));
          this._disarm(state);
          break;
        }
        // Continue only when the pass did something (reserved/delivered a round)
        // or an event asked for another pass. A pass that found nothing to do
        // ends the loop; looping on the same state would never change it.
        if (!productive && !state.requested) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    state.run = run;
    const retire = () => {
      state.run = null;
      if (state.requested && !state.stopping) this._requestDrive(state);
    };
    run.then(retire, retire);
  }

  _ready(state) {
    const { agent } = state;
    if (this.unloading || state.stopping) return false;
    if (!this._live(agent)) return false;
    if (agent.running()) return false;
    if (agent.hasPending()) return false;
    if (state.competingQueued) return false;
    return true;
  }

  // One scheduling pass: deliver an outstanding reservation, or reserve the
  // next round and deliver it. Returns true when it reserved or delivered a
  // round.
  async _drive(state) {
    if (!this._ready(state)) return false;
    if (state.needsCheckpoint) {
      // Durability checkpoint: re-read the goal before reserving so a newer
      // mutation is never raced. A read failure disarms instead of guessing.
      try {
        await this.goals.get(state.agent.sessionId);
        state.needsCheckpoint = false;
      } catch (error) {
        this.logger.warn("[goal-driver] checkpoint failed for session " + state.agent.key + ": " + renderThrown(error));
        this._disarm(state);
        return false;
      }
      if (!this._ready(state)) return false;
    }
    if (state.attempt) {
      // An outstanding reservation: deliver it if it is still queued and it is
      // the queue head. An admitted one whose turn is running is settled by its
      // turn end; someone else's queued input is settled by its own turn end.
      if (state.attempt.phase === "queued") {
        await this._deliverQueued(state);
        return true;
      }
      return false;
    }

    const first = await this._view(state);
    if (!this._drivable(first)) return false;
    if (!this._ready(state)) return false;

    const subagents = this.getSubagents ? this.getSubagents() : null;
    if (subagents && typeof subagents.waitForChildren === "function") {
      try {
        await subagents.waitForChildren(state.agent);
      } catch (_) { /* children gone */ }
      if (!this._ready(state)) return false;
    }

    const view = await this._view(state);
    if (!this._drivable(view)) return false;
    if (!this._ready(state)) return false;
    if (view.goal.roundsStarted >= view.goal.maxGoalRounds) {
      try {
        await this.goals.block(state.agent.sessionId, refOf(view), {
          code: "round-limit",
          message: "Goal reached its configured limit of " + view.goal.maxGoalRounds + " rounds.",
        });
      } catch (error) {
        this.logger.warn("[goal-driver] could not record round-limit: " + renderThrown(error));
      }
      return false;
    }

    const round = view.goal.roundsStarted + 1;
    const attempt = {
      goalId: view.goal.id,
      revision: view.goal.revision,
      round,
      messageId: randomUUID(),
      content: renderGoalRoundPrompt(view.goal, round),
      phase: "queued",
      stale: false,
      cancelled: false,
      accepted: false,
    };
    state.attempt = attempt;
    try {
      state.agent.enqueue({ id: attempt.messageId, content: attempt.content, source: SOURCE }, "next-turn");
    } catch (error) {
      if (state.attempt === attempt) state.attempt = null;
      this.logger.warn("[goal-driver] could not queue round " + round + ": " + renderThrown(error));
      try {
        await this.goals.block(state.agent.sessionId, refOf(view), {
          code: "queue-failed",
          message: "Could not queue goal round " + round + ": " + renderThrown(error),
        });
      } catch (_) { /* already reported */ }
      return false;
    }
    await this._deliverQueued(state);
    return true;
  }

  // A queued reservation on an idle session is delivered by asking the runtime
  // for a turn: the runtime asks its sources and this driver's admit() claims
  // the reserved prompt exactly once.
  async _deliverQueued(state) {
    const attempt = state.attempt;
    const agent = state.agent;
    if (!attempt || attempt.phase !== "queued" || attempt.stale) return;
    if (!agent || agent.running() || this.unloading || state.stopping) return;
    if (!this._live(agent)) return;
    const head = agent.inbox.nextTurn[0];
    if (!head || head.id !== attempt.messageId) return; // someone else's input goes first
    try {
      // No caller input: the source supplies the opening message.
      await this.runtime.chat({ sessionId: agent.sessionId });
    } catch (error) {
      // A failed launch must not loop: disarm and let the human resume.
      this.logger.warn("[goal-driver] delivery failed for session " + agent.key + ": " + renderThrown(error));
      this._disarm(state);
    }
  }

  // A goal round in flight was cancelled: pause the goal once (a further pause
  // transition would be illegal and would only log noise).
  _pause(state) {
    if (state.pausedOnce) return;
    state.pausedOnce = true;
    (async () => {
      const view = await this._view(state);
      if (!view || !view.goal || view.goal.phase !== "active") return;
      try {
        await this.goals.pause(state.agent.sessionId, refOf(view));
      } catch (error) {
        this.logger.warn("[goal-driver] could not pause after cancel: " + renderThrown(error));
      }
    })();
  }
}

const __exports = { GoalRoundDriver, renderGoalRoundPrompt };
export { GoalRoundDriver, renderGoalRoundPrompt };
export default __exports;
