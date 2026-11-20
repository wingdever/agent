"use strict";

// Node-graph agent-loop engine. Phases are explicit nodes; every node receives
// (input, ctx) and reaches services through ctx.services. The engine only owns
// scheduling, hooks, turn finalization and the [turn] log.

  const { loadNodes } = require("./registry");
  const { readLoops } = require("./loops-config");
  const { TurnError } = require("../turn-error");
  const { RequestSpec } = require("../memory");

const ENTRY_NODE = "turn-start";

class NodeGraphEngine {
  constructor() {
    this.nodes = loadNodes();
    this.hooks = {};
    for (const id of this.nodes.keys()) {
      this.hooks[id] = { before: [], after: [], onError: [] };
    }
    this._wireHooksFromOverlay();
  }

  registerHook(nodeId, slot, fn) {
    if (!this.hooks[nodeId]) this.hooks[nodeId] = { before: [], after: [], onError: [] };
    if (!Array.isArray(this.hooks[nodeId][slot])) throw new Error("invalid hook slot: " + slot);
    if (typeof fn !== "function") throw new Error("hook must be a function");
    this.hooks[nodeId][slot].push(fn);
    return this;
  }

  _wireHooksFromOverlay() {
    const hooks = readLoops();
    for (const entry of hooks) {
      try {
        const { on, slot, target } = entry;
        this.registerHook(on, slot, async (input, ctx) => {
          const node = this.nodes.get(target);
          if (!node) return { action: "continue" };
          await node.run(input, ctx);
          return { action: "continue" };
        });
      } catch (err) {
        console.error("[loops] skip bad hook entry " + JSON.stringify(entry) + ": " + ((err && err.message) || err));
      }
    }
  }

  async _runNode(nodeId, input, ctx) {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new TurnError("node-not-found", "node-graph: unknown node '" + nodeId + "'");
    }
    let currentInput = input;
    const beforeHooks = this.hooks[nodeId] ? this.hooks[nodeId].before : [];
    for (const fn of beforeHooks) {
      const instr = await fn(currentInput, ctx);
      if (!instr || instr.action === "continue") continue;
      if (instr.action === "modify") { currentInput = instr.input; continue; }
      if (instr.action === "short-circuit") return { output: instr.output, done: true, shortCircuited: true };
      if (instr.action === "goto") return this._dispatch(instr.next, currentInput, ctx);
      throw new TurnError("bad-hook", "before hook returned unknown action: " + instr.action);
    }

    let result;
    try {
      result = await node.run(currentInput, ctx);
    } catch (err) {
      const onErrorHooks = this.hooks[nodeId] ? this.hooks[nodeId].onError : [];
      for (const fn of onErrorHooks) {
        const instr = await fn(err, ctx);
        if (!instr || instr.action === "continue") continue;
        if (instr.action === "short-circuit") return { output: instr.output, done: true, shortCircuited: true };
        if (instr.action === "goto") return this._dispatch(instr.next, currentInput, ctx);
        throw new TurnError("bad-hook", "onError hook returned unknown action: " + instr.action);
      }
      throw err;
    }
    if (!result || typeof result !== "object") result = { output: result };

    let currentOutput = result.output;
    const afterHooks = this.hooks[nodeId] ? this.hooks[nodeId].after : [];
    for (const fn of afterHooks) {
      const instr = await fn(currentOutput, ctx);
      if (!instr || instr.action === "continue") continue;
      if (instr.action === "modify") { currentOutput = instr.input; continue; }
      if (instr.action === "short-circuit") return { output: instr.output, done: true, shortCircuited: true };
      if (instr.action === "goto") return this._dispatch(instr.next, currentOutput, ctx);
      throw new TurnError("bad-hook", "after hook returned unknown action: " + instr.action);
    }
    result.output = currentOutput;
    return result;
  }

  async _dispatch(nodeId, input, ctx) {
    let currentNodeId = nodeId;
    let currentInput = input;
    for (;;) {
      const result = await this._runNode(currentNodeId, currentInput, ctx);
      if (result.done) return result;
      const node = this.nodes.get(currentNodeId);
      const nextId = result.next || (node ? node.next : null);
      if (!nextId) return { output: result.output, done: true };
      currentNodeId = nextId;
      currentInput = result.output;
    }
  }

  async runLoop(core, ctx, agentArg) {
    const agent = agentArg || core.agent.current();
    if (!agent) throw new Error("node-graph: no agent instance for this turn");
    const persist = !!(agent.sessionId && core.store);
    const onEvent = ctx.onEvent || (() => {});
    // The instance owns the turn: phase, delivery state and abort all live
    // there, so two sessions running at once never share a field.
    const startedAt = Date.now();
    const turnHandle = agent.beginTurn({
      emit: onEvent,
      autonomy: ctx.autonomy,
      effort: ctx.effort,
      activity: ctx.activity,
      interactions: core.interactions,
    });
    const nctx = {
      core,
      runtime: core.agent,
      agent,
      services: {
        config: core.config,
        model: core.model,
        context: core.context,
        tools: core.tools,
        skills: core.skills,
        interactions: core.interactions,
        subagents: core.subagents,
        store: core.store,
        goals: core.goals,
      },
      emit: onEvent,
      signal: turnHandle.signal,
      session: { id: agent.sessionId, persist },
      input: {
        messages: ctx.messages,
        references: ctx.references,
        cwd: ctx.cwd,
        source: ctx.inputSource,
        contextMessages: ctx.contextMessages,
      },
      toolNames: ctx.toolNames,
      autonomy: ctx.autonomy,
      activity: ctx.activity,
      request: new RequestSpec({
        model: ctx.model,
        effort: ctx.effort,
        stream: ctx.stream,
        sessionId: agent.sessionId,
        onEvent,
      }),
      turn: { row: null, startedAt, stepSeq: 0, steps: 0, toolsUsed: 0 },
      step: null,
      translatedUser: null,
      translateCfg: null,
    };

    let status = "succeeded";
    let reason = "no-tool-calls";
    let errorText = null;
    try {
      const result = await this._dispatch(ENTRY_NODE, nctx, nctx);
      return result.output;
    } catch (err) {
      status = "failed";
      reason = err instanceof TurnError ? err.reason : "unexpected-exception";
      errorText = String((err && err.message) || err);
      if (persist && nctx.turn.row) {
        try {
          if (nctx.step && nctx.step.row) await core.store.run("step.update", { id: nctx.step.row.id, status: "failed" });
        } catch (_) {}
        try {
          await core.store.run("turn.update", { id: nctx.turn.row.id, status: "failed" });
        } catch (_) {}
      }
      return { role: "assistant", content: "", error: errorText, stopReason: reason };
    } finally {
      // The turn ends exactly once, here: phase back to idle, delivery state
      // dropped, idle waiters released.
      turnHandle.finish();
      const durationMs = Date.now() - startedAt;
      console.log(
        "[turn] session=" + (agent.sessionId || "none") +
        " turn=" + (nctx.turn.row ? nctx.turn.row.id : "-") +
        " status=" + status + " reason=" + reason +
        " steps=" + nctx.turn.steps + " tools=" + nctx.turn.toolsUsed +
        " duration=" + durationMs + "ms" +
        (errorText ? " error=" + JSON.stringify(errorText.slice(0, 300)) : "")
      );
      nctx.emit({ type: "turn-end", status, reason, steps: nctx.turn.steps, tools: nctx.turn.toolsUsed, durationMs, error: errorText || undefined });
      nctx.emit({ type: "model-http-status", state: "on-wait" });
    }
  }
}

module.exports = { runLoop: (core, ctx, agent) => new NodeGraphEngine().runLoop(core, ctx, agent), NodeGraphEngine };
