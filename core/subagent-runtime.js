"use strict";

import crypto from "crypto";
import { parseStructured } from "./../lib/workflow-runtime/index.js";

// One-shot subagent runtime (docs/agents/subagent.md).
//
// This harness has no resident agent loop / inbox / sendWaking like DSH. The
// DSH-equivalent behaviors are mapped onto the request/response loop as:
//   - spawn() is fire-and-forget: the tool returns "started subagent <id>"
//     immediately; the child turn runs in the background.
//   - the child runs on its own agent instance from the registry, so per-turn
//     mutable state (event sink, autonomy, plan/todo, abort) never leaks into
//     the parent turn (DSH's separate child Agent).
//   - the settlement is delivered as a follow-up (auto-continuation) chat() in
//     the parent session, persisted as role=user / source=subagent-settle. This
//     is DSH's `sendWaking(parent, ..., "queue")` when the parent is idle.
//   - errors are never thrown into the parent turn: they are flattened into a
//     settlement message (DSH "no exception to the caller" rule).
//
// runChild / resumeParent are injectable so the runtime can be tested without
// a live model. Defaults drive the real loop engines.

const SUBAGENT_DELEGATION_CONTEXT = "You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.";

const MAX_DIAGNOSTIC_BYTES = 4096;
const DIAGNOSTIC_TRUNCATION_SUFFIX = "\n[diagnostic truncated]";

// 模型侧名称（docs/agents/subagent.md）。
const ROOT_AGENT_NAME = "lead";
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function settlementSummary(childName, stopReason) {
  const subject = `Background subagent ${childName}`;
  switch (stopReason) {
    // 本地子会话可继续（docs/agents/subagent.md）：completed 用可续文案。
    case "completed": return `${subject} finished and will do no further work unless you send it more.`;
    case "aborted": return `${subject} was stopped before it finished.`;
    case "max-tokens": return `${subject} ran out of room before it finished.`;
    case "refusal": return `${subject} declined the task.`;
    case "error": return `${subject} failed before it finished.`;
    default: return `${subject} ended abnormally (${String(stopReason)}) before it finished.`;
  }
}

// Limit a failure detail to MAX_DIAGNOSTIC_BYTES UTF-8 bytes without splitting
// a multi-byte sequence (DSH limitSubagentDiagnostic).
function limitDiagnostic(text) {
  const str = String(text);
  const bytes = Buffer.from(str, "utf8");
  if (bytes.length <= MAX_DIAGNOSTIC_BYTES) return str;
  let prefix = MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(DIAGNOSTIC_TRUNCATION_SUFFIX);
  while (prefix > 0 && (bytes[prefix] & 0xc0) === 0x80) prefix -= 1;
  return bytes.subarray(0, prefix).toString("utf8") + DIAGNOSTIC_TRUNCATION_SUFFIX;
}

// DSH createSettlementMessage: summary + closing text + optional diagnostic,
// all as plain text blocks inside one user message.
function buildSettlementText(childId, stopReason, closingText, diagnostic) {
  const lines = [settlementSummary(childId, stopReason)];
  if (closingText != null && String(closingText).length) {
    lines.push("Its closing message:", String(closingText));
  } else {
    lines.push("It left no closing message.");
  }
  if (diagnostic != null && String(diagnostic).length) {
    lines.push(limitDiagnostic(diagnostic));
  }
  return lines.join("\n");
}

// Map a runLoop result to a settlement stopReason (DSH epochStopReason).
function mapStopReason(result, signal) {
  if (signal && signal.aborted) return "aborted";
  if (!result) return "error";
  if (result.error || result.stopReason) {
    if (result.stopReason === "truncated") return "max-tokens";
    return "error";
  }
  return "completed";
}

// workflow 的 schema 子代理（docs/runtime/workflow.md §6）：把 JSON Schema 作为
// 输出要求注入子代理上下文，落定后对最终文本做严格解析与最小字段校验。
function structuredOutputInstruction(schema) {
  return "Your final answer must be a single JSON value that satisfies this JSON Schema, with no prose before or after it:\n" + JSON.stringify(schema, null, 2);
}

function parseDetachedStructured(text, schema) {
  try {
    return parseStructured(text, schema);
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

class SubagentRuntime {
  constructor(core, deps = {}) {
    this.core = core;
    this.store = core.store;
    this.tasks = new Map();       // childId -> background completion promise
    this.announced = new Set();   // settlement delivered at most once per child
    this.settleLinks = new Map(); // queued settlement inbox id -> output id
    this.controllers = new Map(); // childId -> AbortController (§6.1 独立取消通道)
    this.childContexts = new Map(); // childId -> { parentChatCtx, parentOnEvent } 跨轮次保留，唤醒时复用
    this._waking = new Set();     // sessionId being woken: closes the check-then-launch race
    this._deps = {
      runChild: deps.runChild || ((core, ctx) => core.agent.chat(ctx)),
      resumeParent: deps.resumeParent || ((core, ctx) => core.agent.chat(ctx)),
      now: deps.now || (() => new Date()),
      logger: deps.logger || console,
    };
  }

  // The child runs on its own resident instance. State isolation is structural
  // (separate Agent), not a prototype-chain view: phase, inbox, plan mode,
  // todos, delivery state and abort are all per instance.
  _childAgent(sessionId) {
    const agent = this.core.agent.get(sessionId);
    if (!agent) throw new Error("subagent instance missing for session " + sessionId);
    return agent;
  }

  // DSH queue: a follow-up turn must wait until the parent session is idle.
  async _waitParentIdle(sessionId, maxMs = 30000) {
    const key = String(sessionId);
    const start = this._deps.now().getTime();
    while (this.core.agent.get(sessionId) && this.core.agent.get(sessionId).running()) {
      if (this._deps.now().getTime() - start > maxMs) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  }

  // Fire-and-forget. Returns { childId, name } after the DB rows are created so
  // the delegation tool can acknowledge immediately with the full path name.
  async spawn(spec) {
    const parent = await this._loadParent(spec.parentSessionId);
    // 工具清单对所有会话相同（请求前缀要稳定），spawn 的层级限制放在执行层：
    // 子会话仍能看到 subagent，但调用被拒绝，委派只能走 subagent_fork。
    if (parent.kind === "subagent") {
      throw new Error("subagent is only available in a main session; use subagent_fork to delegate from a subagent session");
    }
    return this._launch({ ...spec, delivery: "parent" }, await this._createChild({ ...spec, delivery: "parent" }, parent));
  }

  // fork 委派：子会话继承父会话到最后一个已完成轮次为止的历史。
  // 父可以是主会话，也可以是子会话，多层树由 subagent_fork 成立。
  async spawnFork(spec) {
    const parent = await this._loadParent(spec.parentSessionId);
    const boundary = await this.store.run("sessionFork.boundary", { session_id: spec.parentSessionId });
    const created = await this._createChild({ ...spec, delivery: "parent" }, parent);
    await this.store.run("sessionFork.add", {
      child_session_id: created.childId,
      parent_session_id: spec.parentSessionId,
      parent_boundary_seq: boundary,
    });
    return this._launch({ ...spec, delivery: "parent" }, created);
  }

  // 统一入口（docs/runtime/workflow.md §2）：与 spawn/spawnFork 共用子会话创建、
  // 命名、实例隔离、权限与工具面，但交付策略由请求给出：
  //   delivery='parent' 轮末照常投递结算（对应 spawn），结果与结算一致；
  //   delivery='caller' 不投递结算，结果只落在返回的 Promise 上，由调用方自取
  //                     （workflow 引擎正在等它，父轮次也正被工具调用占着）。
  // 失败不抛，压平为停止原因，与 spawn 的「异常不外抛」一致。
  async startChild(spec) {
    const delivery = spec.delivery === "caller" ? "caller" : "parent";
    const parent = await this._loadParent(spec.parentSessionId);
    const created = await this._createChild({ ...spec, delivery }, parent);
    const exec = this._childExec(spec);
    const controller = new AbortController();
    const key = String(created.childId);
    this.controllers.set(key, controller);
    const task = this._runChildTurn(spec, created.childId, exec, controller.signal)
      .finally(() => {
        this.controllers.delete(key);
        this.tasks.delete(key);
        this._releaseChild(created.childId);
      });
    this.tasks.set(key, task);
    return {
      childId: created.childId,
      name: created.name,
      result: task,
      dispose: async () => {
        controller.abort();
        try { await task; } catch (_) { /* the settlement is the result, never a throw */ }
      },
    };
  }

  // 实例释放（docs/runtime/workflow.md §4.4）：一个子代理一轮跑完、且没有待领取
  // 输入时，把它的实例移出注册表——会话事实早已在库里，实例只是运行时态。
  // 之后被唤醒时按规则重建（_wakeChild）。释放推到下一拍执行：一轮刚结束时
  // 紧接着到达的输入（inbox 里已有或正在入队）必须先于释放被看见，否则消息会丢。
  _releaseChild(childId) {
    const key = String(childId);
    setImmediate(() => {
      if (this.tasks.has(key)) return; // another run of this child started
      const agent = this.core.agent.get(childId);
      if (!agent) return;
      if (agent.running() || agent.hasPending()) return;
      this.core.agent.agents().dispose(childId);
    });
  }

  // 重建一次子轮次的上下文（docs/agents/subagent.md §3）。上下文不是快照：
  // 工具面按「所有会话相同」的规则取默认可见集，模型与传输参数取当前配置，
  // 子代理一律自主模式（ask -> deny）。这样释放过实例的子代理被唤醒时，
  // 与首次启动走同一条规则，且不需要为它持久化父轮次的瞬时状态。
  _childExec(spec) {
    const parentChatCtx = spec.parentChatCtx || {};
    const settings = this.core.config.readSettings();
    // The parent turn's tool list is name-for-name the one every session shares;
    // an explicit list (tests, restricted callers) is kept, otherwise the
    // default visible set is selected by the same rule turn-start uses.
    const selected = this.core.tools.select(
      Array.isArray(parentChatCtx.toolNames) ? parentChatCtx.toolNames : undefined,
    );
    let model = parentChatCtx.model;
    // resolveTarget picks the provider/model pair; it reports no effort, so the
    // settings value (or the caller's) supplies that part of the route.
    try {
      const target = this.core.config.resolveTarget({
        provider: parentChatCtx.provider,
        model: parentChatCtx.model,
      });
      model = target.model || model;
    } catch (_) {
      // A config that cannot resolve falls back to the caller's fields; the
      // child turn reports the model failure itself.
    }
    const effort = parentChatCtx.effort || settings.effort;
    return {
      messages: [{ role: "user", content: spec.prompt }],
      sessionId: null,
      onEvent: () => {},
      toolNames: selected.map((tool) => tool.name),
      model,
      effort,
      stream: settings.stream,
      activity: parentChatCtx.activity,
      autonomy: "autonomous",
      references: [],
      inputSource: "subagent-prompt",
      contextMessages: [{ role: "user", content: SUBAGENT_DELEGATION_CONTEXT }],
      cwd: spec.cwd,
    };
  }

  async _runChildTurn(spec, childId, template, signal) {
    const exec = Object.assign({}, template, { sessionId: childId, signal });
    if (spec.schema) exec.contextMessages = exec.contextMessages.concat([{ role: "user", content: structuredOutputInstruction(spec.schema) }]);
    let stopReason = "completed";
    let text = "";
    let diagnostic;
    try {
      const result = await this._deps.runChild(this.core, exec);
      stopReason = mapStopReason(result, signal);
      text = result && typeof result.content === "string" ? result.content : "";
      if (stopReason === "error" || stopReason === "max-tokens") {
        diagnostic = (result && (result.error || result.stopReason)) || "subagent loop failed";
      }
    } catch (e) {
      stopReason = signal.aborted ? "aborted" : "error";
      diagnostic = (e && e.message) || String(e);
    }
    const settled = { childId, stopReason, text };
    if (spec.schema !== undefined) {
      if (stopReason === "completed") {
        const parsed = parseDetachedStructured(text, spec.schema);
        if (parsed.error !== undefined) {
          settled.stopReason = "error";
          settled.text = text;
          settled.diagnostic = parsed.error;
        } else {
          settled.structured = parsed.value;
        }
      }
    }
    if (diagnostic !== undefined) settled.diagnostic = diagnostic;
    // parent delivery notifies the model exactly like spawn's child turn does:
    // one settlement message into the parent conversation, after the turn.
    if (spec.delivery !== "caller") {
      const outputId = await this._lastMessageId(childId, "assistant", null);
      await this._linkPrompt(spec, childId);
      const childName = await this.pathOf(childId);
      const settleText = buildSettlementText(childName, settled.stopReason, text, settled.diagnostic);
      await this._deliverSettlement(spec, childId, settleText, outputId);
    }
    return settled;
  }

  async _loadParent(parentSessionId) {
    const parent = await this.store.run("session.get", { id: parentSessionId });
    if (!parent) throw new Error("parent session not found: " + parentSessionId);
    return parent;
  }

  // 名称规则（docs/agents/subagent.md）：1–32 位小写字母/数字/连字符，字母
  // 开头，不能是 lead；省略时取第一个空闲的 agent-N。同父唯一由
  // subagents 表的 UNIQUE (par_sess_id, agent_name) 承担。
  async _allocateAgentName(parentSessionId, requested) {
    const siblings = await this.store.run("subagent.list", { par_sess_id: parentSessionId });
    const taken = new Set(siblings.map((row) => row.agent_name));
    if (requested != null) {
      const name = String(requested);
      if (!AGENT_NAME_PATTERN.test(name) || name === ROOT_AGENT_NAME) {
        throw new Error(`Invalid agent name "${name}": use 1-32 lower-case letters, digits or hyphens, starting with a letter; "lead" is reserved`);
      }
      if (taken.has(name)) {
        throw new Error(`Agent name "${name}" is already used by another subagent of this parent`);
      }
      return name;
    }
    for (let index = 1; ; index += 1) {
      const candidate = `agent-${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // 模型侧完整名称：从根开始沿 subagents 边拼出的斜杠路径；根为 lead。
  async pathOf(sessionId) {
    const parts = [];
    let current = sessionId;
    for (let guard = 0; guard < 100; guard += 1) {
      const row = await this.store.run("subagent.get", { sub_sess_id: current });
      if (!row) break;
      parts.unshift(row.agent_name);
      current = row.par_sess_id;
    }
    return parts.length ? parts.join("/") : ROOT_AGENT_NAME;
  }

  // 控制面（docs/agents/subagent.md）。

  // 会话所在 subagent 树的根：沿 subagents 边向上走到没有父行的会话。
  async rootOf(sessionId) {
    let current = sessionId;
    const seen = new Set();
    for (let guard = 0; guard < 100; guard += 1) {
      const key = String(current);
      if (seen.has(key)) throw new Error("session subagent cycle detected at session " + current);
      seen.add(key);
      const row = await this.store.run("subagent.get", { sub_sess_id: current });
      if (!row) return current;
      current = row.par_sess_id;
    }
    throw new Error("session subagent chain too deep at session " + sessionId);
  }

  // 把模型给出的 agent 名字解析为 Session id（§12，对齐 DSH resolveAgentPath）：
  // `lead` 与完整路径从根开始逐级按名称下钻；单段名字同样当作从根下钻的路径。
  // 某段不是合法 agent 名时，整体按字面 Session id 处理；路径点名不到成员且含
  // 斜杠时抛 AGENT_NAME_NOT_FOUND，否则回落为字面 Session id（解析失败由调用方
  // 的 session.get 判空）。
  async resolveAgent(callerSessionId, agent) {
    const text = String(agent);
    if (text === ROOT_AGENT_NAME) return this.rootOf(callerSessionId);
    const segments = text.split("/");
    if (!segments.every((s) => AGENT_NAME_PATTERN.test(s))) return text; // 字面 Session id
    let current = await this.rootOf(callerSessionId);
    for (const segment of segments) {
      const row = await this.store.run("subagent.byName", { par_sess_id: current, agent_name: segment });
      if (!row) {
        if (text.includes("/")) throw new Error(`agent name not found: ${text}`);
        return text; // 单段名字未命中：回落为字面 Session id
      }
      current = row.sub_sess_id;
    }
    return current;
  }

  // 会话是否在跑一轮：根会话看主 core 的活动集，子会话看运行时的任务/唤醒集合（§16）。
  isRunning(sessionId) {
    const key = String(sessionId);
    return this.tasks.has(key) || this._waking.has(key) || this.core.agent.activeSessions.has(key);
  }

  // send_message（§15.1）：idle 目标起一轮，运行中目标进入 nextStep 队列（§17）。
  // 返回投递回执，不等待目标回答。
  async sendMessage({ senderSessionId, agent, message }) {
    const targetId = await this.resolveAgent(senderSessionId, agent);
    if (String(targetId) === String(senderSessionId)) {
      throw new Error("send_message requires another agent in the subagent tree");
    }
    const target = await this.store.run("session.get", { id: Number(targetId) });
    if (!target) throw new Error(`agent not found: ${agent}`);
    const [senderRoot, targetRoot] = await Promise.all([
      this.rootOf(senderSessionId),
      this.rootOf(Number(targetId)),
    ]);
    if (String(senderRoot) !== String(targetRoot)) {
      throw new Error(`agent "${agent}" is not in your subagent tree`);
    }
    const senderName = await this.pathOf(senderSessionId);
    const content = `Agent ${senderName} sent a message: ${message}`;
    const messageId = crypto.randomUUID();
    if (this.isRunning(targetId)) {
      const targetAgent = this.core.agent.get(Number(targetId));
      if (!targetAgent) throw new Error(`agent "${agent}" is running but has no live instance`);
      // A running target sees this at its next step boundary. It is not a
      // settlement: it stays a user message with source=agent-message.
      targetAgent.enqueue({ id: messageId, content, source: "agent-message" }, "next-step");
      return { messageId };
    }
    const link = await this.store.run("subagent.get", { sub_sess_id: Number(targetId) });
    if (link) {
      await this._wakeChild(Number(targetId), link.par_sess_id, content);
    } else {
      this._wakeRoot(Number(targetId), content);
    }
    return { messageId };
  }

  // interrupt_agent（§15.2）：祖先可停止任意后代的当前轮次；已结束目标是成功空操作。
  async interruptAgent({ callerSessionId, agent }) {
    const targetId = await this.resolveAgent(callerSessionId, agent);
    if (String(targetId) === String(callerSessionId)) {
      throw new Error("an agent cannot interrupt itself");
    }
    let current = Number(targetId);
    const seen = new Set();
    let descendant = false;
    for (let guard = 0; guard < 100; guard += 1) {
      const row = await this.store.run("subagent.get", { sub_sess_id: current });
      if (!row) break;
      if (String(row.par_sess_id) === String(callerSessionId)) { descendant = true; break; }
      current = row.par_sess_id;
      const key = String(current);
      if (seen.has(key)) break;
      seen.add(key);
    }
    if (!descendant) {
      throw new Error(`interrupt_agent requires an agent created under you: ${agent}`);
    }
    const controller = this.controllers.get(String(targetId));
    if (controller) controller.abort();
    return { accepted: true };
  }

  // list_agents（§15.3）：返回整棵树（根 + 所有可达的可续后代，含调用方自己）。
  // 每行含 name（从根起的斜杠路径）、description（sessions.name）、status；
  // 本项目只有本地子级，status 只取 running / inactive，诊断状态不出现。
  async listAgents({ callerSessionId }) {
    const rootId = await this.rootOf(callerSessionId);
    const rows = [];
    const visit = async (sessionId, name) => {
      const session = await this.store.run("session.get", { id: Number(sessionId) });
      rows.push({
        name,
        description: session ? session.name : "",
        status: this.isRunning(sessionId) ? "running" : "inactive",
      });
      const children = await this.store.run("subagent.list", { par_sess_id: Number(sessionId) });
      for (const child of children) {
        const childName = name === ROOT_AGENT_NAME ? child.agent_name : `${name}/${child.agent_name}`;
        await visit(child.sub_sess_id, childName);
      }
    };
    await visit(rootId, ROOT_AGENT_NAME);
    return rows;
  }

  // wait_agent（docs/agents/inbox.md §8）：等待调用方自己的 nextStep 出现
  // 未报告过的输入，不消费输入。send_message 与结算通知在父轮运行中时都会
  // 进入这个队列；wait_agent 只标记已报告，真正的领取发生在下一个 step 边界。
  async waitAgent({ callerSessionId, timeoutMs = 30000, signal } = {}) {
    const agent = callerSessionId != null ? this.core.agent.get(Number(callerSessionId)) : null;
    if (!agent) throw new Error("wait_agent requires a live caller agent");
    if (!agent.running()) throw new Error("wait_agent can only run inside an active turn");
    const timeout = Number.isInteger(timeoutMs) ? timeoutMs : 30000;
    if (timeout < 10000 || timeout > 3600000) {
      throw new Error("timeout_ms must be an integer between 10000 and 3600000");
    }
    const pending = await agent.waitForNextStep({ timeoutMs: timeout, signal });
    if (!pending) return { timedOut: true };
    agent.markNextStepReported(pending.map((item) => item.id));
    return { timedOut: false, pending: pending.length };
  }

  // Called by model-call after a queued settlement has a persisted message row.
  // The output association is best-effort and never blocks the step.
  async linkSettlement({ inboxId, messageId } = {}) {
    const outputId = this.settleLinks.get(inboxId);
    if (outputId == null || messageId == null) return;
    try {
      await this.store.run("subagentSettle.add", { output_id: outputId, settle_id: messageId });
    } catch (e) {
      this._deps.logger.warn("[subagent] settle association failed:", (e && e.message) || e);
    }
    this.settleLinks.delete(inboxId);
  }

  // 唤醒 idle 的子会话：用消息作为本轮输入起一轮，轮末照常给父发结算（§14）。
  async _wakeChild(childId, parentSessionId, content) {
    const key = String(childId);
    this._waking.add(key);
    try {
      // A child's instance is released once its turn settles; waking it means
      // rebuilding that instance from the session facts. A rebuild failure is
      // surfaced to the sender instead of silently dropping the message.
      try {
        await this.core.agent.getOrCreate(childId);
      } catch (e) {
        throw new Error(`agent ${childId} cannot be woken: ${(e && e.message) || e}`);
      }
      const stored = this.childContexts.get(key) || {};
      const link = await this.store.run("subagent.get", { sub_sess_id: Number(childId) });
      const created = { childId, name: await this.pathOf(childId) };
      return this._launch({
        prompt: content,
        parentSessionId,
        parentChatCtx: stored.parentChatCtx || {},
        parentOnEvent: stored.parentOnEvent,
        delivery: link && link.delivery === "caller" ? "caller" : "parent",
        inputSource: "agent-message",
      }, created);
    } finally {
      this._waking.delete(key);
    }
  }

  // 唤醒树根（子级 send_message 给 lead 时）：起一轮，无结算对象。
  _wakeRoot(rootId, content) {
    const key = String(rootId);
    this._waking.add(key);
    const task = this._deps.resumeParent(this.core, {
      messages: [{ role: "user", content }],
      sessionId: rootId,
      onEvent: () => {},
      references: [],
      inputSource: "agent-message",
    }).catch((e) => this._deps.logger.warn("[subagent] root wake failed:", (e && e.message) || e))
      .finally(() => {
        this.tasks.delete(key);
        this._waking.delete(key);
      });
    this.tasks.set(key, task);
    return task;
  }

  // 两种委派共用的子会话创建：同 workspace、kind=subagent、分配名称并写委派关联。
  async _createChild(spec, parent) {
    const agentName = await this._allocateAgentName(spec.parentSessionId, spec.name);
    const child = await this.store.run("session.create", {
      workspace_id: parent.workspace_id,
      name: spec.description || "subagent",
      kind: "subagent",
    });
    await this.store.run("subagent.add", {
      sub_sess_id: child.id, par_sess_id: spec.parentSessionId, agent_name: agentName,
      delivery: spec.delivery === "caller" ? "caller" : "parent",
    });
    return { childId: child.id, name: await this.pathOf(child.id) };
  }

  // 后台跑子循环；调用方已经写完会话与关联行。
  _launch(spec, created) {
    const { childId } = created;
    const key = String(childId);
    // 保留父轮次快照，使该子会话被唤醒续跑时仍能看到同样的工具与事件回调（§14）。
    this.childContexts.set(key, {
      parentChatCtx: spec.parentChatCtx || {},
      parentOnEvent: spec.parentOnEvent,
    });
    const task = this._runChild(spec, childId)
      .catch((e) => this._deps.logger.warn("[subagent] background run failed:", (e && e.message) || e))
      .finally(() => {
        this.tasks.delete(key);
        this.controllers.delete(key);
      });
    this.tasks.set(key, task);
    return created;
  }

  async _runChild(spec, childId) {
    const { prompt, cwd, parentChatCtx = {}, modelCallId, inputSource } = spec;
    let stopReason = "completed";
    let closingText = "";
    let diagnostic;

    // 子 Agent 比父轮次活得久：每个子 Agent 持有独立 AbortController，父轮次
    // 取消不自动中止已派发的子 Agent（§6.1）。父 signal 只作发布前取消透传，
    // spawn 一旦返回即与父解耦；子 Agent 的生命周期由自己的 controller 管理。
    const controller = new AbortController();
    this.controllers.set(String(childId), controller);
    const childSignal = controller.signal;

    const childCtx = {
      messages: [{ role: "user", content: prompt }],
      sessionId: childId,
      onEvent: () => {},                  // child trajectory stays isolated (§4.1)
      toolNames: parentChatCtx.toolNames, // same tool list as the parent: the request prefix must stay cacheable
      model: parentChatCtx.model,
      effort: parentChatCtx.effort,
      stream: parentChatCtx.stream,
      activity: parentChatCtx.activity,
      autonomy: "autonomous",             // no approval prompts; ask -> deny
      references: [],
      // 子会话首条 user 消息落库时带来源：委派任务为 subagent-prompt，
      // 控制面唤醒为 agent-message（§15.4）。
      inputSource: inputSource || "subagent-prompt",
      contextMessages: [{ role: "user", content: SUBAGENT_DELEGATION_CONTEXT }],
      signal: childSignal,
      cwd,
    };

    try {
      const result = await this._deps.runChild(this.core, childCtx);
      stopReason = mapStopReason(result, childSignal);
      closingText = result && typeof result.content === "string" ? result.content : "";
      if (stopReason === "error" || stopReason === "max-tokens") {
        diagnostic = (result && (result.error || result.stopReason)) || "subagent loop failed";
      }
    } catch (e) {
      stopReason = childSignal.aborted ? "aborted" : "error";
      diagnostic = (e && e.message) || String(e);
    }

    const outputId = await this._lastMessageId(childId, "assistant", null);
    await this._linkPrompt(spec, childId);

    // caller delivery leaves the result to whoever started the child: no
    // parent notice, ever (docs/runtime/workflow.md §2).
    if (spec.delivery !== "caller") {
      const childName = await this.pathOf(childId);
      const settleText = buildSettlementText(childName, stopReason, closingText, diagnostic);
      await this._deliver(spec, childId, settleText, outputId);
    }
    this._releaseChild(childId);
  }

  // Deliver exactly one settlement; drop with a warning when the parent is gone
  // (§6.4). Never throws, never retries, never stages for later (DSH).
  async _deliver(spec, childId, settleText, outputId) {
    if (spec.delivery === "caller") return;
    return this._deliverSettlement(spec, childId, settleText, outputId);
  }

  // Deliver exactly one settlement; drop with a warning when the parent is gone.
  async _deliverSettlement(spec, childId, settleText, outputId) {
    if (this.announced.has(childId)) return;
    const parentSessionId = spec.parentSessionId;

    // A running parent cannot start another turn. Put the settlement on its
    // nextStep queue instead: wait_agent sees it immediately, and the step
    // boundary claims and persists it with source=subagent-settle.
    const liveParent = this.core.agent && this.core.agent.get
      ? this.core.agent.get(parentSessionId)
      : null;
    if (liveParent && liveParent.running()) {
      const inboxId = crypto.randomUUID();
      if (outputId != null) this.settleLinks.set(inboxId, outputId);
      liveParent.enqueue({ id: inboxId, content: settleText, source: "subagent-settle" }, "next-step");
      this.announced.add(childId);
      return;
    }

    await this._waitParentIdle(parentSessionId);

    let parent;
    try { parent = await this.store.run("session.get", { id: parentSessionId }); } catch (_) {}
    if (!parent || parent.deleted_at) {
      try { await this.store.run("subagent.discard", { sub_sess_id: childId }); } catch (_) {}
      this._deps.logger.warn(`[subagent] settlement for ${childId} dropped: parent session unavailable`);
      return;
    }
    this.announced.add(childId);

    const safeOnEvent = (e) => { try { if (spec.parentOnEvent) spec.parentOnEvent(e); } catch (_) {} };

    try {
      await this._deps.resumeParent(this.core, {
        messages: [{ role: "user", content: settleText }],
        sessionId: parentSessionId,
        onEvent: safeOnEvent,
        toolNames: spec.parentChatCtx && spec.parentChatCtx.toolNames,
        model: spec.parentChatCtx && spec.parentChatCtx.model,
        effort: spec.parentChatCtx && spec.parentChatCtx.effort,
        stream: spec.parentChatCtx && spec.parentChatCtx.stream,
        activity: spec.parentChatCtx && spec.parentChatCtx.activity,
        autonomy: spec.parentChatCtx && spec.parentChatCtx.autonomy,
        references: [],
        inputSource: "subagent-settle",
      });
      const settleId = await this._lastMessageId(parentSessionId, "user", "subagent-settle");
      if (outputId != null && settleId != null) {
        await this.store.run("subagentSettle.add", { output_id: outputId, settle_id: settleId });
      }
    } catch (e) {
      // DSH notifySettlement catch: warn only, never throw / retry.
      try { await this.store.run("subagent.discard", { sub_sess_id: childId }); } catch (_) {}
      this._deps.logger.warn(`[subagent] settlement delivery failed for ${childId}: ${(e && e.message) || e}`);
    }
  }

  // ---- best-effort association-table backfills (never block settlement) ----
  async _lastMessageId(sessionId, role, source) {
    try {
      const base = "SELECT m.id FROM messages m JOIN steps s ON s.id=m.step_id JOIN turns t ON t.id=s.turn_id WHERE t.session_id=$1 AND m.role=$2";
      // pg-micro 的 get/all 返回 Promise，必须 await。
      const row = source == null
        ? await this.store.db.prepare(base + " ORDER BY m.surface_seq DESC LIMIT 1").get(sessionId, role)
        : await this.store.db.prepare(base + " AND m.source=$3 ORDER BY m.surface_seq DESC LIMIT 1").get(sessionId, role, source);
      return row ? row.id : null;
    } catch (_) { return null; }
  }

  async _linkPrompt(spec, childId) {
    try {
      if (!spec.modelCallId) return;
      const call = await this.store.db.prepare("SELECT id FROM calls WHERE call_id=$1").get(spec.modelCallId);
      if (!call) return;
      const promptId = await this._lastMessageId(childId, "user", "subagent-prompt");
      if (promptId == null) return;
      await this.store.run("subagentPrompt.add", { call_id: call.id, prompt_id: promptId });
    } catch (_) {}
  }

  // Test/teardown helper: await all in-flight background runs.
  async drain() {
    await Promise.all([...this.tasks.values()]);
  }
}

const __exports = {
  SubagentRuntime,
  SUBAGENT_DELEGATION_CONTEXT,
  ROOT_AGENT_NAME,
  AGENT_NAME_PATTERN,
  settlementSummary,
  limitDiagnostic,
  buildSettlementText,
  mapStopReason,
};
export { SubagentRuntime, SUBAGENT_DELEGATION_CONTEXT, ROOT_AGENT_NAME, AGENT_NAME_PATTERN, settlementSummary, limitDiagnostic, buildSettlementText, mapStopReason };
export default __exports;
