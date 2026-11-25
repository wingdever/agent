"use strict";

import crypto from "crypto";
import { runBareChat } from "./bare-chat.js";
import { getLoop } from "./loops/index.js";
import { AgentRegistry } from "./memory/index.js";

// Process container: the shared services, the agent registry, and the process
// gates that outlive any one turn.
//
// Two levels are deliberately distinct (docs/agents/agent-instance.md §1-2):
//   - the registry is plural: reach any session's instance by id;
//   - the cursor is singular: the session of the last turn, used when a caller
//     does not name a session.
//
// Gates stay out of the instances because a non-turn path can start them (RPC
// manual compaction) and they must outlive "is this session running a turn".
class AgentRuntime {
  constructor({ config, model, context, tools, skills, interactions, store }) {
    this.config = config;
    this.model = model;
    this.context = context;
    this.tools = tools;
    this.skills = skills;
    this.interactions = interactions;
    this.store = store;
    this.core = null;
    this.getSubagents = () => null;
    // Turn sources (docs/agents/lifecycle.md §2), highest priority first.
    this.turnSources = [];
    this.jobs = null;
    this.terminals = null;
    this.lsp = null;
    this.team = null;
    this.bootId = crypto.randomUUID();
    this.activeSessions = new Set();
    this.compacting = new Map();
    this.shared = this.services();
    this.registry = new AgentRegistry({
      shared: this.shared,
      gates: {
        activeSessions: this.activeSessions,
        compacting: this.compacting,
        bootId: this.bootId,
      },
    });
  }

  setCore(core) {
    this.core = core;
  }

  // ---- turn sources ----

  // Register a producer that may open a turn while a session is idle. The
  // runtime asks the sources on every idle turn start, after the human's queued
  // input has had its chance; the highest priority that answers wins.
  // `admit(agent)` returns { message: { content, source }, claim } or null.
  // Returns the unregister function.
  registerTurnSource(source = {}) {
    const name = typeof source.name === "string" && source.name ? source.name : null;
    if (!name || typeof source.admit !== "function") {
      throw new Error("registerTurnSource requires a name and an admit(agent) function");
    }
    const priority = Number.isFinite(source.priority) ? source.priority : 0;
    // Re-registering a name replaces the previous entry; ties keep registration
    // order, so later registrations never jump ahead of equal priorities.
    this.turnSources = this.turnSources.filter((entry) => entry.name !== name);
    const entry = { name, priority, admit: source.admit };
    this.turnSources.push(entry);
    this.turnSources.sort((a, b) => b.priority - a.priority);
    return () => {
      this.turnSources = this.turnSources.filter((item) => item !== entry);
    };
  }

  // Ask the registered sources, highest priority first, whether one of them
  // opens this turn. A source that throws is skipped with a warning.
  async _askTurnSources(agent) {
    for (const source of this.turnSources) {
      let admitted = null;
      try {
        admitted = await source.admit(agent);
      } catch (error) {
        console.warn("[turn-source] " + source.name + " admit failed for session " + agent.key + ": " + ((error && error.message) || error));
        continue;
      }
      if (admitted && admitted.message && typeof admitted.message.content === "string") {
        return { ...admitted, source: source.name };
      }
    }
    return null;
  }

  setSubagents(factory) {
    this.getSubagents = factory;
    // Instances created before the subagent runtime existed still see it: the
    // shared bag object is mutated in place, never replaced.
    this.registry.shared.subagents = factory();
    for (const agent of this.registry.list()) agent.subagents = this.registry.shared.subagents;
  }

  setJobs(jobs) {
    this.jobs = jobs;
    this.registry.shared.jobs = jobs;
  }

  setTerminals(terminals) {
    this.terminals = terminals;
    this.registry.shared.terminals = terminals;
  }

  setLsp(lsp) {
    this.lsp = lsp;
    this.registry.shared.lsp = lsp;
  }

  setTeam(team) {
    this.team = team;
    this.registry.shared.team = team;
  }

  services() {
    return {
      config: this.config,
      model: this.model,
      context: this.context,
      tools: this.tools,
      skills: this.skills,
      interactions: this.interactions,
      subagents: this.getSubagents(),
      jobs: this.jobs,
      terminals: this.terminals,
      lsp: this.lsp,
      team: this.team,
      store: this.store,
    };
  }

  // ---- instance access ----

  agents() {
    return this.registry;
  }

  // The cursor instance: created on first use for the selected session, or
  // null when no session was ever selected.
  current() {
    return this.registry.current();
  }

  // The runtime opening a turn from a source passes no caller input; the
  // opening input comes from admit() instead. Exposed for turn sources.
  // (Documented in docs/agents/lifecycle.md §2.)

  async getOrCreate(sessionId) {
    return this.registry.getOrCreate(sessionId);
  }

  // Read-only instance access for control paths that must not create one.
  get(sessionId) {
    return this.registry.get(sessionId);
  }

  list() {
    return this.registry.list();
  }

  // Run one turn. The instance owns the turn; this only picks it, decides which
  // input opens it, and delegates to the loop engine.
  //
  // Selection: an explicit sessionId selects that session; anything else uses
  // the cursor. The cursor is derived by the registry (selected agent, else the
  // most recent working session, else the standing bare session), so a bare
  // turn never displaces a working session from it.
  //
  // Opening input, in priority order (docs/agents/lifecycle.md §2.3):
  //   1. a human input already queued in nextTurn;
  //   2. a turn source that answers admit() (highest priority first);
  //   3. whatever input the caller passed.
  // The caller's input is queued behind an input that a source or the queue
  // already provided, so no turn ever bypasses a waiting one.
  async chat(ctx = {}) {
    if (!this.core) throw new Error("agent runtime is not attached to a core");
    if (ctx.mode === "bare") {
      const agent = this.registry.openBare();
      this.registry.setCurrent(agent);
      return runBareChat(this.core, ctx, agent);
    }
    let agent;
    if (ctx.sessionId != null) {
      // A registered instance is always the one to run. Only an unknown session
      // without a store cannot be looked up: it runs on a transient instance
      // rather than probing storage for a session that cannot exist there.
      agent = this.store || this.registry.has(ctx.sessionId)
        ? await this.getOrCreate(ctx.sessionId)
        : this.registry.createTransient(ctx.sessionId);
    } else {
      agent = (await this._pickAgent(ctx)) || this.registry.createTransient();
    }
    const input = this._callerInput(ctx);
    if (agent.running()) {
      // Busy only changes where the input lands; it is never an error.
      if (input) agent.enqueue({ content: input.content, source: input.source }, ctx.target === "next-step" ? "next-step" : "next-turn");
      return { queued: true, sessionId: agent.sessionId };
    }
    const opening = await this._openingInput(agent, input);
    if (!opening) {
      // Nothing to open with: the caller supplied no input either.
      return { queued: false, skipped: true, sessionId: agent.sessionId };
    }
    if (input && opening !== input) {
      // The caller's own input waits behind the opening one.
      agent.enqueue({ content: input.content, source: input.source }, "next-turn");
    }
    this.registry.setCurrent(agent);
    this.registry.touch(agent.sessionId);
    return this._runLoop(agent, {
      ...ctx,
      sessionId: agent.sessionId,
      messages: [{ role: "user", content: opening.content }],
      inputSource: opening.source,
      autonomy: opening.autonomous ? "autonomous" : ctx.autonomy,
      claim: opening.claim || null,
    });
  }

  // The caller's own opening input, if any. An empty source is the human's:
  // every non-human producer passes its own source (docs/agents/lifecycle.md).
  _callerInput(ctx) {
    const last = Array.isArray(ctx.messages) && ctx.messages.length ? ctx.messages[ctx.messages.length - 1] : null;
    if (!last || last.role !== "user") return null;
    return { content: last.content, source: ctx.inputSource || "user" };
  }

  // Decide which input opens this idle turn.
  async _openingInput(agent, callerInput) {
    const head = agent.inbox.nextTurn[0];
    if (head && head.source === "user") {
      const item = agent.claimNextTurn();
      return item ? { content: item.content, source: item.source, claim: null } : null;
    }
    const admitted = await this._askTurnSources(agent);
    if (admitted) {
      return { content: admitted.message.content, source: admitted.message.source, claim: admitted.claim || null, autonomous: true };
    }
    const queued = agent.claimNextTurn();
    if (queued) return { content: queued.content, source: queued.source, claim: null };
    return callerInput;
  }

  // The session to run when the caller names none: the most recent working
  // session, otherwise the oldest queued input, otherwise the cursor/bare.
  async _pickAgent(ctx) {
    const cursor = this.current();
    if (cursor && !cursor.running()) return cursor;
    for (const candidate of this.registry.list()) {
      if (candidate.sessionId == null) continue;
      if (candidate.kind !== "normal") continue;
      if (candidate.running() || !candidate.hasPending()) continue;
      return this.getOrCreate(candidate.sessionId);
    }
    return cursor || null;
  }

  async _runLoop(agent, ctx) {
    const engineName = process.env.AGENT_LOOP_ENGINE;
    const loop = await getLoop(engineName);
    return loop.runLoop(this.core, ctx, agent);
  }

  // Manual compaction is a session operation: it targets the named session or
  // the cursor when the cursor is a persisted session.
  async compactSession(opts = {}) {
    const current = this.current();
    const sessionId = opts.sessionId != null ? opts.sessionId : (current ? current.sessionId : null);
    if (sessionId == null) return { ok: false, error: "compact requires a session" };
    return this.context.compactSession(Object.assign({}, opts, { sessionId }));
  }
}

const __exports = { AgentRuntime };
export { AgentRuntime };
export default __exports;
