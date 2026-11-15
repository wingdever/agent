"use strict";

const crypto = require("crypto");
const { runBareChat } = require("./bare-chat");
const { getLoop } = require("./loops");

// Agent runtime: owns the per-process turn state and dispatches to the session
// mode (bare-chat) or the active loop engine. It deliberately does not read
// config, expose RPC, or own approval tables.
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
    this.activeSessions = new Set();
    this.compacting = new Map();
    this.bootId = crypto.randomUUID();
    this.autonomy = "supervised";
    this.effort = null;
    this.activity = "bare-chat";
    this.emit = () => {};
  }

  setCore(core) {
    this.core = core;
  }

  setSubagents(factory) {
    this.getSubagents = factory;
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
    };
  }

  beginTurn({ emit = () => {}, autonomy = "supervised" } = {}) {
    this.emit = emit;
    this.autonomy = autonomy === "autonomous" ? "autonomous" : "supervised";
    this.interactions.beginTurn({ emit, autonomy: this.autonomy });
  }

  async chat(ctx = {}) {
    if (!this.core) throw new Error("agent runtime is not attached to a core");
    if (!this.emit || this.emit === undefined) this.emit = ctx.onEvent || (() => {});
    if (ctx.mode === "bare") return runBareChat(this.core, ctx);
    return this._runLoop(ctx);
  }

  async _runLoop(ctx) {
    const engineName = process.env.AGENT_LOOP_ENGINE;
    const loop = getLoop(engineName);
    return loop.runLoop(this.core, ctx);
  }

  async compactSession(opts = {}) {
    return this.context.compactSession(opts);
  }
}

module.exports = { AgentRuntime };
