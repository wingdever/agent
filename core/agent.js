"use strict";

const crypto = require("crypto");
const { runBareChat } = require("./bare-chat");
const { getLoop } = require("./loops");
const { AgentRegistry } = require("./memory");

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
  constructor({ config, model, context, tools, skills, interactions, store, goals }) {
    this.config = config;
    this.model = model;
    this.context = context;
    this.tools = tools;
    this.skills = skills;
    this.interactions = interactions;
    this.store = store;
    this.goals = goals;
    this.core = null;
    this.getSubagents = () => null;
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

  setSubagents(factory) {
    this.getSubagents = factory;
    // Instances created before the subagent runtime existed still see it: the
    // shared bag object is mutated in place, never replaced.
    this.registry.shared.subagents = factory();
    for (const agent of this.registry.list()) agent.subagents = this.registry.shared.subagents;
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
      store: this.store,
      goals: this.goals,
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

  // Run one turn. The instance owns the turn; this only picks it and delegates.
  //
  // Selection: an explicit sessionId selects that session; anything else uses
  // the cursor. The cursor is derived by the registry (selected agent, else the
  // most recent working session, else the standing bare session), so a bare
  // turn never displaces a working session from it.
  //
  // A turn with neither still runs: no sessionId and no cursor falls back to a
  // fresh transient instance, never to "there is no agent".
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
      agent = this.current() || this.registry.createTransient();
    }
    const onEvent = ctx.onEvent || (() => {});
    if (agent.running()) {
      // Busy only changes where the input lands; it is never an error.
      const last = Array.isArray(ctx.messages) && ctx.messages.length ? ctx.messages[ctx.messages.length - 1] : null;
      if (last && last.role === "user") {
        agent.enqueue({ content: last.content, source: ctx.inputSource }, ctx.target === "next-step" ? "next-step" : "next-turn");
      }
      return { queued: true, sessionId: agent.sessionId };
    }
    // The session that just ran is the selected agent. Its activity stamp also
    // records that it is the most recently used working session.
    this.registry.setCurrent(agent);
    this.registry.touch(agent.sessionId);
    return this._runLoop(agent, ctx);
  }

  async _runLoop(agent, ctx) {
    const engineName = process.env.AGENT_LOOP_ENGINE;
    const loop = getLoop(engineName);
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

module.exports = { AgentRuntime };
