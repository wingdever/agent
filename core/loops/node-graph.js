"use strict";

// 节点化、支持 hook 的 agent-loop 引擎（第二种 loopEngine，见 docs/agent-loop-node-graph.md）。
//
// 与 linear.js 的区别：把 chat() 主循环里隐式写死在 for 循环里的阶段显式化为一组节点
// （core/loops/nodes/*），由内置调度器按节点的 next 串起来跑。两种引擎共用同一批 core
// 方法（_stream / requestApproval / tool.run ...），只差「调用方是函数循环还是节点调度器」。
//
// 行为目标：node-graph 的默认编排在能力上等价于 linear（测试见 test/loop-node-graph.test.js）。

const fs = require("fs");
const path = require("path");
const { loadNodes } = require("./registry");
const { readSettings } = require("./shared");
const { readLoops } = require("./loops-config");
const { resolveConfig: resolveTranslateConfig } = require("../translation");
const { TurnError } = require("../turn-error");
const planMode = require("../plan-mode");
const { reset: resetTodos } = require("../todo-state");

// 默认入口节点：整轮从这里开始。
const ENTRY_NODE = "resolve-input";

class NodeGraphEngine {
  constructor() {
    // 节点表：Map<nodeId, Node>。每次 runLoop 前重新 load（支持热加载节点目录）。
    this.nodes = loadNodes();
    // 钩子表：Map<nodeId, { before:[], after:[], onError:[] }>，按注册顺序执行成管道。
    this.hooks = {};
    for (const id of this.nodes.keys()) {
      this.hooks[id] = { before: [], after: [], onError: [] };
    }
    // 从 user/loops.json 覆盖层注册 hook（与 settings.translate.enabled 解耦）。
    this._wireHooksFromOverlay();
  }

  // 注册普通 hook（生命周期回调）。
  // slot ∈ before | after | onError；fn(input, ctx) => instruction
  //   before/after 返回 { action: "continue"|"modify"(input) | "short-circuit"(output?) | "goto"(next) }
  //   onError    返回 { action: "continue"(向上抛) | "short-circuit"(output?) | "goto"(next) }
  registerHook(nodeId, slot, fn) {
    if (!this.hooks[nodeId]) this.hooks[nodeId] = { before: [], after: [], onError: [] };
    if (!Array.isArray(this.hooks[nodeId][slot])) throw new Error("invalid hook slot: " + slot);
    if (typeof fn !== "function") throw new Error("hook must be a function");
    this.hooks[nodeId][slot].push(fn);
    return this;
  }

  // Register hooks from the user/loops.json overlay. Each entry {on, slot, target}
  // attaches a hook that runs the target node (builtin OR core) and always returns
  // {action:"continue"}. A bad overlay entry must never crash engine construction:
  // log and skip it. Array order is preserved by registerHook push order.
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

  // 执行某个节点（含 before/after 钩子）。返回节点 run 的指令结果。
  async _runNode(nodeId, input, ctx) {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new TurnError("node-not-found", "node-graph: unknown node '" + nodeId + "'");
    }
    // before 钩子管道。
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

    // 节点主体（带 onError 钩子）。
    let result;
    try {
      result = await node.run(currentInput, ctx);
    } catch (err) {
      const onErrorHooks = this.hooks[nodeId] ? this.hooks[nodeId].onError : [];
      for (const fn of onErrorHooks) {
        const instr = await fn(err, ctx);
        if (!instr || instr.action === "continue") continue; // 向上抛
        if (instr.action === "short-circuit") return { output: instr.output, done: true, shortCircuited: true };
        if (instr.action === "goto") return this._dispatch(instr.next, currentInput, ctx);
        throw new TurnError("bad-hook", "onError hook returned unknown action: " + instr.action);
      }
      throw err; // 无兜底 → 向上抛
    }
    if (!result || typeof result !== "object") result = { output: result };

    // after 钩子管道（可改 output / 短路 / 跳转）。
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

  // 派发到下一节点（递归处理 goto）。统一解释 next / done。
  async _dispatch(nodeId, input, ctx) {
    let currentNodeId = nodeId;
    let currentInput = input;
    // goto 可能链式跳转，用循环而非无限递归；节点数有限，层数不会失控。
    for (;;) {
      const result = await this._runNode(currentNodeId, currentInput, ctx);
      if (result.done) return result;
      // 节点可显式返回 next 覆盖 registry.next；否则用 registry.next。
      const node = this.nodes.get(currentNodeId);
      const nextId = result.next || (node ? node.next : null);
      if (!nextId) {
        // 无下一节点：视为正常结束（等价于 done）。
        return { output: result.output, done: true };
      }
      currentNodeId = nextId;
      currentInput = result.output;
    }
  }

  // 引擎入口：与 linear.runLoop(core, ctx) 签名一致。
  async runLoop(core, ctx) {
    const {
      messages,
      toolNames,
      model,
      onEvent = () => {},
      sessionId,
      stream,
      autonomy,
      activity,
      references,
      effort,
    } = ctx;

    core._onEvent = onEvent;
    core.autonomy = autonomy === "autonomous" ? "autonomous" : "supervised";
    // 推理参数：none(或旧值 off)=关推理，其余非空值=分级推理(reasoning_effort，按 provider 字段映射)，空=不注入。
    // 分级推理取值 provider 相关（radeon 的 minimal/xhigh、deepseek 的 max 等），不再硬编码白名单。
    core.effort = (effort && effort !== "undefined") ? effort : null;
    core.activity = activity === "plan-mode" ? "plan-mode" : (activity || "bare-chat");
    // activity=plan-mode 驱动 per-session plan-mode：选 plan-mode 即进入计划态，切到其它 activity 即退出。
    if (sessionId) planMode.setActive(sessionId, core.activity === "plan-mode");

    const store = core.store;
    const persist = !!(sessionId && store);
    // 持久化 turn 独占会话：/compact 等手动压缩需等本轮释放（与 linear 一致）。
    if (persist) {
      const compactionGate = core.compacting.get(String(sessionId));
      if (compactionGate) await compactionGate;
      core.activeSessions.add(String(sessionId));
    }
    // DSH 在 turn 开始时重置 todo 投影；一次 chat() 即一个 turn。
    resetTodos(sessionId);

    // 每一条退出路径都留下终止原因（由外层 catch/finally 统一记录 [turn] 并广播 turn-end）。
    const startedAt = Date.now();
    let status = "succeeded";
    let reason = "no-tool-calls";
    let errorText = null;
    let steps = 0;
    let toolsUsed = 0;

    // 调度器共享的 ctx（跨节点可变状态，等价于 linear 的 chat() 局部变量集合）。
    const nctx = {
      core,
      onEvent,
      messages,
      toolNames,
      model,
      sessionId,
      stream,
      autonomy,
      activity,
      references,
      effort,
      inputSource: ctx.inputSource,
      contextMessages: ctx.contextMessages,
      cwd: ctx.cwd,
      persist,
      store,
      stepSeq: 0,
      toolsUsed: 0,
      translatedUser: null,
      translateCfg: resolveTranslateConfig(readSettings()),
    };

    try {
      const result = await this._dispatch(ENTRY_NODE, messages, nctx);
      steps = nctx.steps || 0;
      toolsUsed = nctx.toolsUsed || 0;
      // result.output 为最终 assistant message（或 short-circuit 的 output）。
      return result.output;
    } catch (err) {
      // 预期内终止（请求失败/截断/空回复/翻译错误）与未知异常在此汇合，由 reason 区分。
      status = "failed";
      reason = err instanceof TurnError ? err.reason : "unexpected-exception";
      errorText = String((err && err.message) || err);
      if (persist && nctx.turn) {
        try { if (nctx.currentStep) await store.run("step.update", { id: nctx.currentStep.id, status: "failed" }); } catch (_) {}
        try { await store.run("turn.update", { id: nctx.turn.id, status: "failed" }); } catch (_) {}
      }
      return { role: "assistant", content: "", error: errorText, stopReason: reason };
    } finally {
      if (persist) core.activeSessions.delete(String(sessionId));
      const durationMs = Date.now() - startedAt;
      console.log("[turn] session=" + (sessionId || "none") + " turn=" + (nctx.turn ? nctx.turn.id : "-") +
        " status=" + status + " reason=" + reason +
        " steps=" + steps + " tools=" + toolsUsed + " duration=" + durationMs + "ms" +
        (errorText ? " error=" + JSON.stringify(errorText.slice(0, 300)) : ""));
      onEvent({ type: "turn-end", status, reason, steps, tools: toolsUsed, durationMs, error: errorText || undefined });
      onEvent({ type: "model-http-status", state: "on-wait" });
    }
  }
}

module.exports = { runLoop: (core, ctx) => new NodeGraphEngine().runLoop(core, ctx), NodeGraphEngine };
