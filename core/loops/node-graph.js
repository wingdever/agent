"use strict";

// Node-graph agent-loop engine. Phases are explicit nodes; every node receives
// (input, ctx) and reaches services through ctx.services. The engine only owns
// scheduling, hooks, turn finalization and the [turn] log.

  import { loadNodes } from "./registry.js";
  import { readLoops } from "./loops-config.js";
  import { TurnError } from "./../turn-error.js";
  import { RequestSpec } from "./../memory/index.js";

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

  // The turn context both entry points share: services, signal, request and
  // the turn-level counters. `runLoop` starts from turn-start; `resumeLoop`
  // adopts a stored turn and starts at the paused step.
  _context(core, agent, turnHandle, inputCtx, onEvent) {
    const persist = !!(agent.sessionId && core.store);
    return {
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
        workflow: core.workflow,
        jobs: core.jobs,
        terminals: core.terminals,
        lsp: core.lsp,
        team: core.team,
        schedule: core.schedule,
        a2a: core.a2a,
        store: core.store,
        goals: core.goals,
        mcp: core.mcp,
      },
      emit: onEvent,
      signal: turnHandle.signal,
      session: { id: agent.sessionId, persist },
      input: {
        messages: inputCtx.messages,
        references: inputCtx.references,
        cwd: inputCtx.cwd,
        source: inputCtx.inputSource,
        contextMessages: inputCtx.contextMessages,
      },
      toolNames: inputCtx.toolNames,
      persona: inputCtx.persona,
      autonomy: inputCtx.autonomy,
      activity: inputCtx.activity,
      request: new RequestSpec({
        model: inputCtx.model,
        effort: inputCtx.effort,
        stream: inputCtx.stream,
        sessionId: agent.sessionId,
        onEvent,
      }),
      turn: { row: turnHandle.turn.row || null, startedAt: Date.now(), stepSeq: turnHandle.turn.stepSeq || 0, steps: 0, toolsUsed: 0 },
      step: null,
      pendingStepMessages: [],
      pendingTurnMessages: () => [],
      resume: null,
      translatedUser: null,
      translateCfg: null,
    };
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

  // Continue a turn that was paused: the stored turn and step are adopted, the
  // step's assistant/call rows are reloaded, and execution goes straight to the
  // pause point's next node. turn-start and model-call never run on this path
  // (docs/runtime/turn-pause.md §4.5).
  async resumeLoop(core, agent) {
    const pause = agent.pause.continueAt;
    // Adopted once, here: from now on the turn is a live one.
    agent.pause.continueAt = null;
    const turnRow = pause && pause.step ? pause.step.turnRow : null;
    const stepInfo = pause && pause.step ? pause.step.step : null;
    if (!turnRow || !stepInfo) throw new TurnError("resume-failed", "no stored turn to continue");
    const onEvent = (event) => { if (agent.turn && agent.turn.emit) agent.turn.emit(event); };
    const startedAt = Date.now();
    const turnHandle = agent.beginTurn({
      emit: onEvent,
      autonomy: "supervised",
      activity: agent.turn ? agent.turn.activity : "agent",
      interactions: core.interactions,
      continuing: { row: turnRow, stepSeq: stepInfo ? stepInfo.seq : 0 },
    });
    const nctx = this._context(core, agent, turnHandle, { messages: [] }, onEvent);
    nctx.resume = { step: stepInfo, pausedAt: pause.pausedAt };
    nctx.turn.row = turnRow;
    nctx.turn.stepSeq = stepInfo ? stepInfo.seq : 0;
    let status = "succeeded";
    let reason = "resumed";
    let errorText = null;
    try {
      const result = await this._dispatch("resume-step", nctx, nctx);
      return result.output;
    } catch (err) {
      if (agent.phase && agent.phase.cancelReason) {
        reason = agent.phase.cancelReason;
      } else {
        status = "failed";
        reason = err instanceof TurnError ? err.reason : "unexpected-exception";
      }
      errorText = String((err && err.message) || err);
      return { role: "assistant", content: "", error: errorText, stopReason: reason };
    } finally {
      turnHandle.finish({
        status,
        reason,
        steps: nctx.turn.steps,
        tools: nctx.turn.toolsUsed,
        durationMs: Date.now() - startedAt,
      });
      console.log("[turn] session=" + (agent.sessionId || "none") + " turn=" + turnRow.id +
        " status=" + status + " reason=" + reason + " (continued)");
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
      claim: ctx.claim || null,
    });
    const nctx = this._context(core, agent, turnHandle, ctx, onEvent);

    let status = "succeeded";
    let reason = "no-tool-calls";
    let errorText = null;
    try {
      const result = await this._dispatch(ENTRY_NODE, nctx, nctx);
      return result.output;
    } catch (err) {
      // A cancelled turn ended because someone stopped it, not because it
      // failed: report the loop's "interrupted" reason, not a provider error.
      if (agent.phase && agent.phase.cancelReason) {
        status = "succeeded";
        reason = agent.phase.cancelReason;
      } else {
        status = "failed";
        reason = err instanceof TurnError ? err.reason : "unexpected-exception";
      }
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
      turnHandle.finish({
        status,
        reason,
        steps: nctx.turn.steps,
        tools: nctx.turn.toolsUsed,
        durationMs: Date.now() - startedAt,
      });
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

export default { runLoop: (core, ctx, agent) => new NodeGraphEngine().runLoop(core, ctx, agent), resumeLoop: (core, agent) => new NodeGraphEngine().resumeLoop(core, agent), NodeGraphEngine };
