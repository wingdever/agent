"use strict";

// One-shot subagent runtime (docs/dev/subagent.md # 第一步实现).
//
// This harness has no resident agent loop / inbox / sendWaking like DSH. The
// DSH-equivalent behaviors are mapped onto the request/response loop as:
//   - spawn() is fire-and-forget: the tool returns "started subagent <id>"
//     immediately; the child turn runs in the background.
//   - the child runs in an independent session with an isolated core view so
//     per-turn mutable state (event sink, autonomy, plan/todo) never leaks into
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

function settlementSummary(childId, stopReason) {
  const subject = `Background subagent ${childId}`;
  switch (stopReason) {
    case "completed": return `${subject} finished. It cannot receive follow-up messages.`;
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

class SubagentRuntime {
  constructor(core, deps = {}) {
    this.core = core;
    this.store = core.store;
    this.tasks = new Map();       // childId -> background completion promise
    this.announced = new Set();   // settlement delivered at most once per child
    this.controllers = new Map(); // childId -> AbortController (§6.1 独立取消通道)
    this._deps = {
      runChild: deps.runChild || ((childCore, ctx) => childCore.chat(ctx)),
      resumeParent: deps.resumeParent || ((resumeCore, ctx) => resumeCore.chat(ctx)),
      now: deps.now || (() => new Date()),
      logger: deps.logger || console,
    };
  }

  // Independent core view: shares read-only config (apiKey/baseUrl/model,
  // tools/store/skills/goals/bootId) via the prototype chain, but owns its own
  // per-turn mutable state so it cannot disturb the parent turn in flight.
  _isolatedCore() {
    const p = this.core;
    const c = Object.create(p);
    c._onEvent = () => {};
    c.autonomy = "autonomous";
    c.effort = p.effort;
    c.activity = p.activity;
    c.activeSessions = new Set();
    c.compacting = new Map();
    c.pendingApprovals = new Map();
    c.pendingQuestions = new Map();
    c.pendingPlanReviews = new Map();
    c.pendingUserJobs = new Map();
    c.userJobs = new Map();
    // Permission scope fixed: ask -> deny, no approval-request event (§4.3).
    c.requestApproval = () => Promise.resolve("deny");
    return c;
  }

  // DSH queue: a follow-up turn must wait until the parent session is idle.
  async _waitParentIdle(sessionId, maxMs = 30000) {
    const key = String(sessionId);
    const start = this._deps.now().getTime();
    while (this.core.activeSessions.has(key)) {
      if (this._deps.now().getTime() - start > maxMs) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  }

  // Fire-and-forget. Returns the child session id synchronously (after the DB
  // row is created) so the delegation tool can acknowledge immediately.
  async spawn(spec) {
    const { description, parentSessionId } = spec;
    const parent = await this.store.run("session.get", { id: parentSessionId });
    if (!parent) throw new Error("parent session not found: " + parentSessionId);
    // 工具清单对所有会话相同（请求前缀要稳定），spawn 的层级限制放在执行层：
    // 子会话仍能看到 subagent，但调用被拒绝，委派只能走 subagent_fork。
    if (parent.kind === "subagent") {
      throw new Error("subagent is only available in a main session; use subagent_fork to delegate from a subagent session");
    }

    const child = await this.store.run("session.create", {
      workspace_id: parent.workspace_id,
      name: description || "subagent",
      kind: "subagent",
    });
    const childId = child.id;
    await this.store.run("subagent.add", { sub_sess_id: childId, par_sess_id: parentSessionId });

    const task = this._runChild(spec, childId)
      .catch((e) => this._deps.logger.warn("[subagent] background run failed:", (e && e.message) || e))
      .finally(() => {
        this.tasks.delete(childId);
        this.controllers.delete(childId);
      });
    this.tasks.set(childId, task);
    return { childId };
  }

  async _runChild(spec, childId) {
    const { prompt, cwd, parentChatCtx = {}, modelCallId } = spec;
    let stopReason = "completed";
    let closingText = "";
    let diagnostic;

    // 子 Agent 比父轮次活得久：每个子 Agent 持有独立 AbortController，父轮次
    // 取消不自动中止已派发的子 Agent（§6.1）。父 signal 只作发布前取消透传，
    // spawn 一旦返回即与父解耦；子 Agent 的生命周期由自己的 controller 管理。
    const controller = new AbortController();
    this.controllers.set(childId, controller);
    const childSignal = controller.signal;

    const childCore = this._isolatedCore();
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
      // 子会话首条 user 消息（task prompt）落库时带 source=subagent-prompt，
      // 供 subagent_prompts 关联表回填（§5）。
      inputSource: "subagent-prompt",
      contextMessages: [{ role: "user", content: SUBAGENT_DELEGATION_CONTEXT }],
      signal: childSignal,
      cwd,
    };

    try {
      const result = await this._deps.runChild(childCore, childCtx);
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

    const settleText = buildSettlementText(childId, stopReason, closingText, diagnostic);
    await this._deliver(spec, childId, settleText, outputId);
  }

  // Deliver exactly one settlement; drop with a warning when the parent is gone
  // (§6.4). Never throws, never retries, never stages for later (DSH).
  async _deliver(spec, childId, settleText, outputId) {
    if (this.announced.has(childId)) return;
    const parentSessionId = spec.parentSessionId;

    await this._waitParentIdle(parentSessionId);

    let parent;
    try { parent = await this.store.run("session.get", { id: parentSessionId }); } catch (_) {}
    if (!parent || parent.deleted_at) {
      try { await this.store.run("subagent.discard", { sub_sess_id: childId }); } catch (_) {}
      this._deps.logger.warn(`[subagent] settlement for ${childId} dropped: parent session unavailable`);
      return;
    }
    this.announced.add(childId);

    const resumeCore = this._isolatedCore();
    const safeOnEvent = (e) => { try { if (spec.parentOnEvent) spec.parentOnEvent(e); } catch (_) {} };

    try {
      await this._deps.resumeParent(resumeCore, {
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

module.exports = {
  SubagentRuntime,
  SUBAGENT_DELEGATION_CONTEXT,
  settlementSummary,
  limitDiagnostic,
  buildSettlementText,
  mapStopReason,
};
