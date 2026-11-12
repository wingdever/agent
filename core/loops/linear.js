"use strict";

// 线性 agent-loop 引擎（原 core/index.js chat() 主循环抽离而来）。
// 行为保持与抽离前完全一致；只是把"调用方"从函数式循环换成节点调度器之外的
// 另一种形态。runLoop(core, ctx) 与 index.js 的 chat() 入参一致：
//   core = AgentCore 实例（所有 this.xxx 方法都挂在这里）
//   ctx  = { messages, toolNames, model, onEvent, sessionId, stream, autonomy, activity, references, effort }
//
// 这是 loopEngine 注册表的默认引擎（AGENT_LOOP_ENGINE 缺省/未知时回落到它），
// 以保证向后兼容与现有测试不退化。

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DEFAULT_IDENTITY, assembleSystemPrompt } = require("../system-prompt");
const { readPermissions, permissionFor } = require("../permissions");
const { readFsPolicy, resolveFsPermission } = require("../fs-policy");
const {
  resolveConfig: resolveTranslateConfig,
  shouldTranslateUser,
  shouldTranslateAssistant,
  translateText,
} = require("../translation");
const compaction = require("../compaction");
const { validateToolArgs, runTool } = require("../tools/executor");
const { errorResult } = require("../tools/result");
const { reset: resetTodos } = require("../todo-state");
const planMode = require("../plan-mode");
const { TurnError } = require("../turn-error");
const { prepareUserInput } = require("../user-input");

// readSettings 是 index.js 的模块级函数；这里复刻一份最小实现，避免循环依赖。
const SETTINGS_FILE = path.join(__dirname, "..", "..", "user", "settings.json");
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (_) { return {}; }
}

// resolveProvider 是 index.js 的模块级函数（读取 user/providers.json）；复刻一份最小实现。
const PROVIDERS_FILE = path.join(__dirname, "..", "..", "user", "providers.json");
function resolveProvider(name) {
  if (!name) return null;
  let providers;
  try { providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); } catch (_) { return null; }
  if (!Array.isArray(providers)) return null;
  const p = providers.find((x) => x.name === name);
  if (!p) return null;
  const models = Array.isArray(p.models) ? p.models : [];
  const model = models.length ? (models[0].name || models[0]) : null;
  return { baseUrl: p.base_url, apiKey: p.api_key, model };
}

async function runLoop(core, ctx) {
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
  // 推理参数：none(或旧值 off)=关闭推理，其余非空值=分级推理(reasoning_effort，按 provider 字段映射)，空=不注入。
  // 注意：分级推理的取值是 provider 相关的（如 radeon 的 minimal/xhigh、deepseek 的 max），不再硬编码白名单。
  core.effort = (effort && effort !== "undefined") ? effort : null;
  core.activity = activity === "goal-plan" ? "goal-plan" : (activity || "bare-chat");
  // activity=goal-plan 驱动 per-session plan-mode：选 goal-plan 即进入计划态（POLICY 生效），
  // 切到其他 activity 即退出（见 docs/agent-mode.md）。exit_plan_mode 批准后由 UI 切到 build-code。
  if (sessionId) planMode.setActive(sessionId, core.activity === "goal-plan");
  const store = core.store;
  const persist = !!(sessionId && store);
  // A persisted turn owns the session: /compact and manual compaction must
  // wait until the loop releases it (DSH runMaintenance's idle claim).
  if (persist) {
    const compactionGate = core.compacting.get(String(sessionId));
    if (compactionGate) await compactionGate;  // DSH queues waking input behind compaction
    core.activeSessions.add(String(sessionId));
  }
  // DSH resets the todo projection on turn/start; one chat() call is one turn.
  resetTodos(sessionId);
  // 每一条退出路径都必须留下终止原因：循环体内只负责抛 TurnError 或返回，
  // 由下面的 catch/finally 统一落一条 [turn] 日志并发 turn-end。
  const startedAt = Date.now();
  let status = "succeeded";
  let reason = "no-tool-calls";
  let errorText = null;
  let steps = 0;
  let toolsUsed = 0;
  let turn = null;
  let currentStep = null;
  try {
  // Apply persisted settings (user/settings.json): provider -> baseUrl/apiKey, model, stream.
  const st = readSettings();
  const translateCfg = resolveTranslateConfig(st);
  // Input translation: the model must only see English. A failure blocks the
  // turn before anything is persisted; the UI restores the composer and asks
  // the user to send English instead.
  let translatedUser = null;
  if (translateCfg.enabled && Array.isArray(messages) && messages.length) {
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && shouldTranslateUser(last.content, translateCfg)) {
      onEvent({ type: "translation", role: "user", phase: "start", sourceLang: "zh", targetLang: "en", source: last.content });
      try {
        translatedUser = await translateText({ text: last.content, target: "en", config: translateCfg, sessionId, timeoutMs: translateCfg.inputTimeoutMs });
        onEvent({ type: "translation", role: "user", phase: "done", sourceLang: "zh", targetLang: "en", source: last.content, text: translatedUser });
      } catch (e) {
        const message = String((e && e.message) || e);
        onEvent({ type: "translation", role: "user", phase: "error", sourceLang: "zh", targetLang: "en", source: last.content, error: message });
        throw new TurnError("translation-error", "input translation failed: " + message);
      }
    }
  }
  const effStream = stream !== undefined ? !!stream : (st.stream === true);
  let effModel = model || st.model || core.model;
  if (st.provider) {
    const p = resolveProvider(st.provider);
    if (p) {
      core.baseUrl = p.baseUrl;
      core.apiKey = p.apiKey;
      if (!effModel) effModel = p.model;
    }
  }
  // Deterministic schema/guidance order: registration order is a filesystem artifact.
  const tools = core._selectTools(toolNames);
  const toolDefs = core._toolDefs(tools);
  const permissions = readPermissions();
  const fsPolicy = readFsPolicy();

  // The system prompt belongs to the session's first turn only: it is
  // assembled once, stored once, and displayed once. Later turns reuse the
  // stored text and neither persist nor emit it again. Requests still carry
  // it every time because Chat Completions is stateless.
  const cwd = await core._resolveCwd(persist ? sessionId : null);
  let system = persist ? await store.run("session.prompt", { session_id: sessionId }) : null;
  const systemIsNew = !system;
  if (systemIsNew) {
    system = assembleSystemPrompt({
      identity: typeof st.identity === "string" ? st.identity : DEFAULT_IDENTITY,
      persona: typeof st.persona === "string" ? st.persona : "",
      tools,
      cwd,
      model: effModel,
    }).system;
    onEvent({ type: "system-prompt", content: system });
  }
  // 本轮用户输入：persist 会话下历史由 core 从存储投影（压缩边界 + checkpoint），
  // UI 只需传最后一条 user；bare-chat 仍用内存 messages。
  const lastInput = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  if (!lastInput || lastInput.role !== "user") {
    throw new TurnError("invalid-input", "the last message must be a user message");
  }
  const pendingUser = { role: "user", content: translatedUser != null ? translatedUser : lastInput.content };
  // @引用：把引用文件/会话内容作为上下文注入（位于真实问题之前，独立于翻译步骤）。
  // 由 core/user-input 统一准备，两条 loop 路径共用同一份输入准备逻辑。
  const pendingRefs = await prepareUserInput(core, { references, sessionId, persist });
  let conv;
  if (persist) {
    conv = await core._requestMessages(sessionId, system, [...pendingRefs, pendingUser]);
  } else {
    conv = [{ role: "system", content: system }, ...messages];
    // Replace only the last user turn with its English translation. Earlier
    // turns are already English in the persisted history.
    if (translatedUser != null && conv.length > 1) {
      conv[conv.length - 1] = Object.assign({}, conv[conv.length - 1], { content: translatedUser });
    }
  }
  // r=0 落库前的尾部消息：自动压缩重建历史时追加，落库后不再追加。
  const pendingTurnMessages = () => [...pendingRefs, pendingUser];

  // 开启一轮对话轨迹（持久化）：一个 turn 包含多个 step
  // 每个 step = 一次模型请求 + 其响应（agent-request? + model-response(thought?/answer?/tool-call-card*)）
  // request-time：完成上一步全部 tool-call 后，才在下一轮 step 再次请求模型
  let stepSeq = 0;
  let userPersisted = false;
  if (persist) {
    const turns = await store.run("turn.list", { session_id: sessionId });
    turn = await store.run("turn.create", { session_id: sessionId, seq: turns.length, status: "running" });
  }

  // 终止条件：模型不再返回 tool_calls 才算本轮完成。与 DSH 的 agent loop 一致，
  // 这里不设步数上限 —— 是否继续由模型决定，而不是被一个硬编码的 5 掐断。
  for (let r = 0; ; r++) {
    // Plan-mode guidance is request-scoped: the stored system prompt stays
    // stable, while every step in plan mode carries the policy. exit_plan_mode
    // flips the state off before the next step, so the policy disappears then.
    let requestSystem = system + (planMode.isActive(sessionId) ? "\n\n" + planMode.POLICY : "");

    // 自动压缩（DSH agent/pre-step）：每个 step 请求前按窗口压力检查。
    // 先做模型无关的 tool-result pruning，仍超阈值再写 checkpoint。
    if (persist) {
      // 自动压缩失败不应掐断对话（DSH 在 pre-step 只告警并继续本轮）。
      try {
        const auto = await core._maybeCompactStep({
          sessionId,
          conv,
          system: requestSystem,
          toolDefs,
          model: effModel,
          turn,
          trigger: "pressure",
          pending: () => (r === 0 && !userPersisted ? pendingTurnMessages() : []),
          onEvent,
        });
        conv = auto.conv;
      } catch (error) {
        console.warn("[compaction] automatic pressure pass failed:", (error && error.message) || error);
      }
    }

    // 上一轮的 step 不能背锅：step.create 失败时 catch 只应把 turn 标失败。
    currentStep = null;
    const step = persist ? await store.run("step.create", { turn_id: turn.id, seq: stepSeq++, status: "running" }) : null;
    currentStep = step;
    steps = r + 1;
    // 新一轮 step 开始（r=0 由前端 onSend 预建 UI；r>0 由本事件驱动 UI 建立新 step）
    if (r > 0) onEvent({ type: "step-start", seq: r });

    // step 0：只有 session 首轮落 system；触发本轮的用户请求始终落入本步骤
    // （写库失败只告警：对话仍可继续，历史缺一条不应掐断整轮）
    if (persist && r === 0) {
      try {
        if (systemIsNew) {
          await store.run("message.add", { step_id: step.id, seq: 0, role: "system", content: system });
        }
        const lastUser = [...conv].reverse().find((m) => m.role === "user");
        if (lastUser) {
          const content = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
          await store.run("message.add", { step_id: step.id, seq: systemIsNew ? 1 : 0, role: "user", content });
        }
      } catch (e) {
        onEvent({ type: "error", error: "persist step-0 messages failed: " + (e.message || e) });
      }
      userPersisted = true;
    }

    // 请求模型（request-time：上一步工具已全部执行完才到这里）
    // 错误边界：context-overflow 先尝试 prune/摘要恢复并重试一次；其余失败
    // 转成 TurnError，由外层统一记录 reason=model-request-error。
    conv[0].content = requestSystem;
    let a;
    let overflowRetried = false;
    for (;;) {
      try {
        a = await core._stream({ messages: conv, toolDefs, model: effModel, onEvent, sessionId, stream: effStream });
        break;
      } catch (err) {
        const text = String((err && err.message) || err);
        if (!overflowRetried && persist && compaction.isContextOverflowError(text)) {
          overflowRetried = true;
          onEvent({ type: "compaction", phase: "overflow", trigger: "context-overflow" });
          let recovered = { changed: false };
          try {
            recovered = await core._maybeCompactStep({
              sessionId,
              conv,
              system: requestSystem,
              toolDefs,
              model: effModel,
              turn,
              trigger: "context-overflow",
              pending: () => (r === 0 && !userPersisted ? pendingTurnMessages() : []),
              onEvent,
            });
          } catch (recoveryError) {
            console.warn("[compaction] overflow recovery failed:", (recoveryError && recoveryError.message) || recoveryError);
          }
          if (recovered.changed) {
            conv = recovered.conv;
            requestSystem = system + (planMode.isActive(sessionId) ? "\n\n" + planMode.POLICY : "");
            conv[0].content = requestSystem;
            continue;
          }
        }
        throw new TurnError("model-request-error", text);
      }
    }
    // finish_reason 属于传输层元数据，不能混进后续请求的 messages
    const message = { role: "assistant", content: a.content, reasoning_content: a.reasoning_content, tool_calls: a.tool_calls };
    // DSH usage anchor: remember this request's header/surface price plus the
    // provider usage so the next pressure measurement reuses it.
    if (persist) {
      await core._recordTokenAnchor({
        sessionId,
        model: effModel,
        system: requestSystem,
        tools: toolDefs,
        messages: conv.slice(1),
        assistant: core._cleanMessage(message),
        usage: a.usage,
      });
    }
    conv.push(message);

    // 记录本轮助手回复与（可能的）工具调用（首轮有 system 时整体后移一位）
    const assistantSeq = r === 0 ? (systemIsNew ? 2 : 1) : 0;
    let assistantMsg = null;
    const callIds = [];
    if (persist) {
      // 持久化隔离：写库失败只告警，不能让已经拿到的模型回复丢掉
      try {
        assistantMsg = await store.run("message.add", { step_id: step.id, seq: assistantSeq, role: "assistant", content: message.content || "", thought: message.reasoning_content || "" });
        if (message.tool_calls) {
          for (let i = 0; i < message.tool_calls.length; i++) {
            const tc = message.tool_calls[i];
            let args = {};
            try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { args = {}; }
            const call = await store.run("call.add", {
              reply_id: assistantMsg.id,
              seq: i,
              name: (tc.function && tc.function.name) || "unknown",
              category: (core.tools.get(tc.function && tc.function.name) || {}).type || "unknown",
              call_id: tc.id,
              arguments: (tc.function && tc.function.arguments) || "{}",
              status: "pending",
            });
            callIds.push(call.id);
          }
        }
      } catch (e) {
        onEvent({ type: "error", error: "persist assistant failed: " + (e.message || e) });
      }
    }

    // 结束判定，顺序很关键：先截断、再空回复，最后才是正常收尾。
    if (a.finish_reason === "length") {
      throw new TurnError("truncated", "model response truncated (finish_reason=length)");
    }
    if (!message.tool_calls) {
      if (!String(message.content || "").trim()) {
        throw new TurnError("empty-response", "model returned no content and no tool calls");
      }
      // Output translation: the answer stays English in history; the Chinese
      // version is display-only and is not persisted. A failure never blocks
      // the answer — the UI shows the English text plus a notice.
      if (shouldTranslateAssistant(message.content, translateCfg)) {
        onEvent({ type: "translation", role: "assistant", phase: "start", sourceLang: "en", targetLang: "zh", source: message.content });
        try {
          const translated = await translateText({ text: message.content, target: "zh", config: translateCfg, sessionId, timeoutMs: translateCfg.outputTimeoutMs });
          onEvent({ type: "translation", role: "assistant", phase: "done", sourceLang: "en", targetLang: "zh", source: message.content, text: translated });
        } catch (e) {
          onEvent({
            type: "translation",
            role: "assistant",
            phase: "error",
            sourceLang: "en",
            targetLang: "zh",
            source: message.content,
            error: String((e && e.message) || e),
          });
        }
      }
      onEvent({ type: "done", message });
      if (persist) {
        try { await store.run("step.update", { id: step.id, status: "succeeded" }); }
        catch (e) { onEvent({ type: "error", error: "step.update failed: " + (e.message || e) }); }
        try { await store.run("turn.update", { id: turn.id, status: "succeeded" }); }
        catch (e) { onEvent({ type: "error", error: "turn.update failed: " + (e.message || e) }); }
      }
      return message;
    }

    // 执行本轮全部 tool-call（需用户授权），完成后再回到循环顶部请求模型
    for (let i = 0; i < message.tool_calls.length; i++) {
      const call = message.tool_calls[i];
      const name = (call.function && call.function.name) || "unknown";
      const callId = call.id || "call_" + stepSeq + "_" + i;
      toolsUsed += 1;
      const tool = core.tools.get(name);

      // Parse + validate before approval: malformed arguments never need a
      // permission prompt. The model still receives a normal tool result.
      let args = {};
      let invalid = null;
      try {
        args = JSON.parse((call.function && call.function.arguments) || "{}");
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          invalid = "invalid arguments: arguments must be a JSON object";
        }
      } catch (e) {
        invalid = "invalid arguments: " + (e.message || String(e));
      }
      if (!invalid && !tool) invalid = 'tool "' + name + '" not found';
      if (!invalid) {
        const violations = validateToolArgs(tool, args);
        if (violations.length > 0) invalid = "invalid arguments: " + violations.join("; ");
      }

      const finish = async (result, status) => {
        onEvent({
          type: "tool_result",
          id: callId,
          name,
          content: result.text,
          isError: result.isError === true,
          meta: result.meta,
        });
        conv.push({ role: "tool", tool_call_id: callId, content: result.text });
        if (persist && callIds[i] != null) {
          try {
            await store.run("call.update", {
              id: callIds[i],
              status,
              result: { text: result.text, meta: result.meta, isError: result.isError === true },
            });
          } catch (e) { onEvent({ type: "error", error: "call.update failed: " + (e.message || e) }); }
          try {
            await store.run("message.add", {
              step_id: step.id,
              seq: assistantSeq + 1 + i,
              role: "tool",
              content: result.text,
            });
          } catch (e) { onEvent({ type: "error", error: "message.add failed: " + (e.message || e) }); }
        }
      };

      if (invalid) {
        onEvent({ type: "tool_call", id: callId, name, arguments: args });
        await finish(errorResult(invalid), "failed");
        continue;
      }

      // Permissions come from user/permissions.json: allow executes directly,
      // deny refuses without asking, ask waits for the user. File-writing
      // tools (write/edit) are additionally narrowed/widened by path rules in
      // user/fs-policy.json (deny wins, then first match, else tool-level).
      let permission = permissionFor(permissions, name);
      if (name === "write" || name === "edit") {
        permission = resolveFsPermission(permissions, fsPolicy, name, args && args.file_path, cwd);
      }
      let decision;
      if (permission === "ask") {
        decision = await core.requestApproval({ callId, name, args, permission });
      } else {
        onEvent({ type: "approval-request", callId, name, arguments: args, permission });
        decision = permission === "allow" ? "approve" : "deny";
      }
      if (decision !== "approve") {
        await finish(errorResult(permission === "deny" ? "permission denied" : "user denied"), "denied");
        continue;
      }

      // 授权通过：执行工具。结果已经是模型可见文本；meta 只给 UI/DB。
      onEvent({ type: "tool_call", id: callId, name, arguments: args });
      const result = await runTool(tool, args, {
        cwd,
        sessionId,
        callId,
        toolName: name,
        goals: core.goals,
        isPlanMode: () => planMode.isActive(sessionId),
        reviewPlan: (plan) => core.requestPlanReview({ callId, plan, sessionId }),
        askUserQuestion: (questions) => core.requestUserQuestion({ callId, questions }),
        requestApproval: (payload) => core.requestApproval(payload),
        requestUserJob: (job) => core.requestUserJob({ callId, sessionId, ...job }),
        killUserJob: (jobId) => core.killUserJob(jobId),
        store: core.store,
      });
      await finish(result, result.isError === true ? "failed" : "succeeded");
    }
    if (persist) { try { await store.run("step.update", { id: step.id, status: "succeeded" }); }
    catch (e) { onEvent({ type: "error", error: "step.update failed: " + (e.message || e) }); } }
  }
  // 循环只能从内部 return / throw 退出，这里不需要（也不应该）再有兜底分支。
  } catch (err) {
    // 预期内的终止（请求失败/截断/空回复）与真正的未知异常在这里汇合，
    // 都由 reason 区分；异常终止不再发 done，避免把失败伪装成正常回答。
    status = "failed";
    reason = err instanceof TurnError ? err.reason : "unexpected-exception";
    errorText = String((err && err.message) || err);
    if (persist && turn) {
      try { if (currentStep) await store.run("step.update", { id: currentStep.id, status: "failed" }); } catch (_) {}
      try { await store.run("turn.update", { id: turn.id, status: "failed" }); } catch (_) {}
    }
    return { role: "assistant", content: "", error: errorText, stopReason: reason };
  } finally {
    if (persist) core.activeSessions.delete(String(sessionId));
    const durationMs = Date.now() - startedAt;
    // 每个 turn 结束都留一行原因：正常收尾也打，才能分清"答完了"和"被掐断"。
    console.log("[turn] session=" + (sessionId || "none") + " turn=" + (turn ? turn.id : "-") +
      " status=" + status + " reason=" + reason +
      " steps=" + steps + " tools=" + toolsUsed + " duration=" + durationMs + "ms" +
      (errorText ? " error=" + JSON.stringify(errorText.slice(0, 300)) : ""));
    onEvent({ type: "turn-end", status, reason, steps, tools: toolsUsed, durationMs, error: errorText || undefined });
    onEvent({ type: "model-http-status", state: "on-wait" });
  }
}

module.exports = { runLoop };
