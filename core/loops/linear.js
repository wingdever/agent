"use strict";

// 线性 agent-loop 引擎（原 core/index.js chat() 主循环抽离而来）。
// 行为保持与抽离前完全一致；只是把"调用方"从函数式循环换成节点调度器之外的
// 另一种形态。runLoop(core, ctx) 与 index.js 的 chat() 入参一致：
//   core = createCore 返回的服务集合
//   ctx  = { messages, toolNames, model, onEvent, sessionId, stream, autonomy, activity, references, effort }
//
// 这是冻结的对照基线：默认引擎是 node-graph；linear 只用于对比，
// 不补 subagent 或后续新功能。

import path from "path";
import { DEFAULT_IDENTITY, assembleSystemPrompt } from "./../system-prompt.js";
import _mod0 from "./../skills/index.js";
const { isModelInvocable } = _mod0;
import { readPermissions, permissionFor } from "./../permissions.js";
import _mod1 from "./../fs-policy.js";
const { readFsPolicy, resolveFsPermissionForPaths, fsPathsForTool } = _mod1;
import { resolveConfig as resolveTranslateConfig, shouldTranslateUser, shouldTranslateAssistant, translateText } from "./../translation.js";
import compaction from "./../compaction.js";
import { validateToolArgs, runTool } from "./../tools/executor.js";
import { errorResult, modelContent } from "./../../lib/tool-result/index.js";
import { reset as resetTodos } from "./../../lib/todo-state/index.js";
import planMode from "./../plan-mode.js";
import { RequestSpec, StepState } from "./../memory/index.js";
import { TurnError } from "./../turn-error.js";

async function runLoop(core, ctx, agentArg) {
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

  // 实例拥有本轮：phase、投递态（emit/autonomy/effort/activity）都在 agent 上，
  // 两个会话并发时互不覆盖。
  const agent = agentArg || core.agent.current();
  if (!agent) throw new Error("linear: no agent instance for this turn");
  const handle = agent.beginTurn({ emit: onEvent, autonomy, effort, activity, interactions: core.interactions, claim: ctx.claim || null });
  // activity=plan-mode 驱动 per-session plan-mode：选 plan-mode 即进入计划态（POLICY 生效），
  // 切到其他 activity 即退出。exit_plan_mode 批准后由 UI 切到 build-code。
  if (sessionId) agent.setPlanMode(agent.turn.activity === "plan-mode");
  const store = core.store;
  const persist = !!(sessionId && store);
  // A persisted turn owns the session: /compact and manual compaction must
  // wait until the loop releases it (DSH runMaintenance's idle claim).
  if (persist) {
    const compactionGate = agent.gates.compacting.get(String(sessionId));
    if (compactionGate) await compactionGate;  // DSH queues waking input behind compaction
    agent.gates.activeSessions.add(String(sessionId));
  }
  // DSH resets the todo projection on turn/start; one chat() call is one turn.
  resetTodos(agent);
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
  const st = core.config.readSettings();
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
  const target = core.config.resolveTarget({ provider: st.provider, model: model || st.model });
  // Deterministic schema/guidance order: registration order is a filesystem artifact.
  const tools = core.tools.select(toolNames);
  const toolDefs = core.tools.defs(tools);
  const permissions = readPermissions();
  const fsPolicy = readFsPolicy();
  const request = new RequestSpec({
    model: target.model,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    effort: agent.turn.effort,
    stream: stream !== undefined ? !!stream : (st.stream === true),
    selected: tools,
    toolDefs,
    permissions,
    fsPolicy,
    sessionId,
    onEvent,
  });

  // The system prompt belongs to the session's first turn only: it is
  // assembled once, stored once, and displayed once. Later turns reuse the
  // stored text and neither persist nor emit it again. Requests still carry
  // it every time because Chat Completions is stateless.
  // ctx.cwd 覆盖：子 Agent 委派可带初始工作目录（相对路径基于父当前目录）。
  const baseCwd = await core.context.resolveCwd(persist ? sessionId : null);
  const cwd = ctx.cwd ? path.resolve(baseCwd, ctx.cwd) : baseCwd;
  let system = persist ? await store.run("session.prompt", { session_id: sessionId }) : null;
  const systemIsNew = !system;
  let catalogMsg = null;
  if (systemIsNew) {
    // 会话起始一次性装配 system 文本 + skill 目录消息（user-role）。目录只包含
    // 可模型调用的 skill（模型靠它决定是否调用 skill 工具）；之后所有轮次从存储读回，
    // 不再重新生成。
    const skills = core.skills
      ? (await core.skills.list({ cwd })).filter((s) => isModelInvocable(s))
      : [];
    const assembled = assembleSystemPrompt({
      identity: typeof st.identity === "string" ? st.identity : DEFAULT_IDENTITY,
      persona: typeof st.persona === "string" ? st.persona : "",
      tools,
      cwd,
      model: request.model,
      skills,
      catalogDescriptionMaxLength: st.skills ? st.skills.catalogDescriptionMaxLength : undefined,
      // Only servers that can serve resource calls are listed: the names are the
      // model's argument, so advertising a dead server would invite a failing call.
      mcpResourceServers: core.mcp ? core.mcp.resourceServerNames() : [],
      mcpInstructions: core.mcp ? core.mcp.serverInstructions() : [],
    });
    system = assembled.system;
    if (assembled.block.length > 1) catalogMsg = assembled.block[1];
    onEvent({ type: "system-prompt", content: system });
  }
  // 本轮用户输入：persist 会话下历史由 core 从存储投影（压缩边界 + checkpoint），
  // UI 只需传最后一条 user；bare-chat 仍用内存 messages。
  const lastInput = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  if (!lastInput || lastInput.role !== "user") {
    throw new TurnError("invalid-input", "the last message must be a user message");
  }
  const pendingUser = { role: "user", content: translatedUser != null ? translatedUser : lastInput.content };
  // @引用：把引用文件/会话/技能内容作为上下文注入（位于真实问题之前，独立于翻译步骤）。
  // 由 core/user-input 统一准备，两条 loop 路径共用同一份输入准备逻辑。
  const { refs: pendingRefs } = await core.context.prepareInput({
    text: lastInput.content,
    cwd,
    references,
    sessionId,
    persist
  });
  if (persist) {
    request.messages = await core.context.requestMessages(sessionId, system, [...pendingRefs, pendingUser]);
  } else {
    request.messages = [{ role: "system", content: system }, ...messages];
    // 非持久会话也注入 skill 目录消息（system 之后、用户消息之前），保证模型可见。
    if (catalogMsg) request.messages.splice(1, 0, catalogMsg);
    // Replace only the last user turn with its English translation. Earlier
    // turns are already English in the persisted history.
    if (translatedUser != null && request.messages.length > 1) {
      request.messages[request.messages.length - 1] = Object.assign({}, request.messages[request.messages.length - 1], { content: translatedUser });
    }
  }
  // runtime-context（子 Agent 权限声明等）：作为独立的 user 消息注入请求消息，
  // 只影响本次请求的模型上下文、不落库（父子 system prompt 保持一致）。
  // 插在最后一条 user（本次输入）之前，而不是 system 之后：fork 的继承段必须与
  // 父会话的前缀逐字相同才能命中前缀缓存，插在头部会让整段继承历史失去缓存。
  if (Array.isArray(ctx.contextMessages) && ctx.contextMessages.length) {
    const last = request.messages.length - 1;
    const at = last > 0 && request.messages[last] && request.messages[last].role === "user" ? last : 1;
    request.messages.splice(at, 0, ...ctx.contextMessages);
  }
  // r=0 落库前的尾部消息：自动压缩重建历史时追加，落库后不再追加。
  const pendingTurnMessages = () => [...pendingRefs, pendingUser];

  // 开启一轮对话轨迹（持久化）：一个 turn 包含多个 step
  // 每个 step = 一次模型请求 + 其响应（agent-request? + model-response(thought?/answer?/tool-call-card*)）
  // request-time：完成上一步全部 tool-call 后，才在下一轮 step 再次请求模型
  let stepSeq = 0;
  let stepState = null;
  if (persist) {
    const turns = await store.run("turn.list", { session_id: sessionId });
    turn = await store.run("turn.create", { session_id: sessionId, seq: turns.length, status: "running" });
  }

  // 终止条件：模型不再返回 tool_calls 才算本轮完成。与 DSH 的 agent loop 一致，
  // 这里不设步数上限 —— 是否继续由模型决定，而不是被一个硬编码的 5 掐断。
  for (let r = 0; ; r++) {
    // Apply a pending plan-mode exit from a prior approved exit_plan_mode at the
    // top of this step (DSH's next in-turn pre-step): the rest of that tool
    // batch stayed under plan guidance; this step's request header is the first
    // without the policy. Broadcast so the UI indicator settles in lockstep.
    if (r > 0 && agent.applyPlanExit()) {
      onEvent({ type: "plan-mode", active: false });
    }
    // Record the plan-active value this request header will observe, then flush
    // any deferred switch notices decided at setActive (DSH's activeAtLastHeader
    // de-dup). The notices are appended to the request messages and persisted so the model is
    // told exactly when its context changed and never redundantly.
    agent.recordHeaderPlanMode();
    const switchNotices = agent.takePlanNotices();
    // Plan-mode guidance is request-scoped: the stored system prompt stays
    // stable, while every step in plan mode carries the policy. exit_plan_mode
    // defers the flip to the next step, so the policy disappears then.
    request.planActive = agent.planPolicyActive();
    request.header = system + (request.planActive ? "\n\n" + planMode.POLICY : "");

    // 自动压缩（DSH agent/pre-step）：每个 step 请求前按窗口压力检查。
    // 先做模型无关的 tool-result pruning，仍超阈值再写 checkpoint。
    if (persist) {
      // 自动压缩失败不应掐断对话（DSH 在 pre-step 只告警并继续本轮）。
      try {
        const auto = await core.context.maybeCompactStep({
          sessionId,
          conv: request.messages,
          system: request.header,
          toolDefs: request.toolDefs,
          model: request.model,
          trigger: "pressure",
          pending: () => (r === 0 && !(stepState && stepState.userPersisted) ? pendingTurnMessages() : []),
          onEvent,
        });
        request.messages = auto.conv;
      } catch (error) {
        console.warn("[compaction] automatic pressure pass failed:", (error && error.message) || error);
      }
    }

    // 上一轮的 step 不能背锅：step.create 失败时 catch 只应把 turn 标失败。
    currentStep = null;
    const row = persist ? await store.run("step.create", { turn_id: turn.id, seq: stepSeq++, status: "running" }) : null;
    stepState = new StepState({ row });
    currentStep = stepState;
    steps = r + 1;
    // Per-step message sequence counter: system/catalog/user/notices/assistant/tool
    // all share one monotonically increasing seq (UNIQUE(step_id, seq)).
    const nextSeq = () => stepState.nextSeq();
    // 新一轮 step 开始（r=0 由前端 onSend 预建 UI；r>0 由本事件驱动 UI 建立新 step）
    if (r > 0) onEvent({ type: "step-start", seq: r });

    // step 0：只有 session 首轮落 system + 目录消息；触发本轮的用户请求始终落入本步骤
    // （写库失败只告警：对话仍可继续，历史缺一条不应掐断整轮）。目录消息排 system 之后、
    // 真实用户之前（docs/skills/skills.md 5.2）。
    if (persist && r === 0) {
      try {
        if (systemIsNew) {
          await store.run("message.add", { step_id: stepState.row.id, seq: nextSeq(), role: "system", content: system });
          if (catalogMsg) {
            await store.run("message.add", { step_id: stepState.row.id, seq: nextSeq(), role: "user", content: catalogMsg.content });
          }
        }
        // 真实用户请求（pendingUser）。即使后面追加了 /name 手势，也要以真实
        // 用户输入落库，不能因为请求消息里最后一条 user 是手势而把它吞掉。
        const userContent = typeof pendingUser.content === "string" ? pendingUser.content : JSON.stringify(pendingUser.content);
        await store.run("message.add", { step_id: stepState.row.id, seq: nextSeq(), role: "user", content: userContent, source: ctx.inputSource });
      } catch (e) {
        onEvent({ type: "error", error: "persist step-0 messages failed: " + (e.message || e) });
      }
      stepState.userPersisted = true;
    }

    // Flush deferred plan-mode switch notices: append to request messages (after the user
    // prefix, matching DSH's "after the reusable request prefix") and persist as
    // role:user messages so they survive replay. Empty unless setActive crossed
    // the boundary the previous header observed, so no redundant narration.
    for (const notice of switchNotices) {
      request.messages.push({ role: "user", content: notice });
      if (persist && stepState.row) {
        try {
          await store.run("message.add", { step_id: stepState.row.id, seq: nextSeq(), role: "user", content: notice });
        } catch (e) {
          onEvent({ type: "error", error: "persist plan-mode notice failed: " + (e.message || e) });
        }
      }
    }

    // 请求模型（request-time：上一步工具已全部执行完才到这里）
    // 错误边界：context-overflow 先尝试 prune/摘要恢复并重试一次；其余失败
    // 转成 TurnError，由外层统一记录 reason=model-request-error。
    request.messages[0].content = request.header;
    let overflowRetried = false;
    for (;;) {
      try {
        stepState.response = await core.model.stream({
          messages: request.messages,
          toolDefs: request.toolDefs,
          model: request.model,
          baseUrl: request.baseUrl,
          apiKey: request.apiKey,
          effort: request.effort,
          onEvent,
          sessionId: request.sessionId,
          stream: request.stream,
        });
        break;
      } catch (err) {
        const text = String((err && err.message) || err);
        if (!overflowRetried && persist && compaction.isContextOverflowError(text)) {
          overflowRetried = true;
          onEvent({ type: "compaction", phase: "overflow", trigger: "context-overflow" });
          let recovered = { changed: false };
          try {
            recovered = await core.context.maybeCompactStep({
              sessionId,
              conv: request.messages,
              system: request.header,
              toolDefs: request.toolDefs,
              model: request.model,
              trigger: "context-overflow",
              pending: () => (r === 0 && !(stepState && stepState.userPersisted) ? pendingTurnMessages() : []),
              onEvent,
            });
          } catch (recoveryError) {
            console.warn("[compaction] overflow recovery failed:", (recoveryError && recoveryError.message) || recoveryError);
          }
          if (recovered.changed) {
            request.messages = recovered.conv;
            request.header = system + (agent.planPolicyActive() ? "\n\n" + planMode.POLICY : "");
            request.messages[0].content = request.header;
            continue;
          }
        }
        throw new TurnError("model-request-error", text);
      }
    }
    // finish_reason 属于传输层元数据，不能混进后续请求的 messages
    const message = { role: "assistant", content: stepState.response.content, reasoning_content: stepState.response.reasoning_content, tool_calls: stepState.response.tool_calls };
    // DSH usage anchor: remember this request's header/surface price plus the
    // provider usage so the next pressure measurement reuses it.
    if (persist) {
      await core.context.recordTokenAnchor({
        sessionId,
        model: request.model,
        system: request.header,
        tools: request.toolDefs,
        messages: request.messages.slice(1),
        assistant: core.context.cleanMessage(message),
        usage: stepState.response.usage,
      });
    }
    request.messages.push(message);

    // 记录本轮助手回复与（可能的）工具调用（首轮有 system 时整体后移一位）
    const assistantSeq = nextSeq();
    if (persist) {
      // 持久化隔离：写库失败只告警，不能让已经拿到的模型回复丢掉
      try {
        stepState.assistantMsg = await store.run("message.add", { step_id: stepState.row.id, seq: assistantSeq, role: "assistant", content: message.content || "", thought: message.reasoning_content || "" });
        if (message.tool_calls) {
          for (let i = 0; i < message.tool_calls.length; i++) {
            const tc = message.tool_calls[i];
            let args = {};
            try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { args = {}; }
            const call = await store.run("call.add", {
              reply_id: stepState.assistantMsg.id,
              seq: i,
              name: (tc.function && tc.function.name) || "unknown",
              category: (core.tools.get(tc.function && tc.function.name) || {}).type || "unknown",
              call_id: tc.id,
              arguments: (tc.function && tc.function.arguments) || "{}",
              status: "pending",
            });
            stepState.callIds.push(call.id);
          }
        }
      } catch (e) {
        onEvent({ type: "error", error: "persist assistant failed: " + (e.message || e) });
      }
    }

    // 结束判定，顺序很关键：先截断、再空回复，最后才是正常收尾。
    if (stepState.response.finish_reason === "length") {
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
        try { await store.run("step.update", { id: stepState.row.id, status: "succeeded" }); }
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
        request.messages.push({ role: "tool", tool_call_id: callId, content: modelContent(result) });
        if (persist && stepState.callIds[i] != null) {
          try {
            await store.run("call.update", {
              id: stepState.callIds[i],
              status,
              result: { text: result.text, meta: result.meta, isError: result.isError === true },
            });
          } catch (e) { onEvent({ type: "error", error: "call.update failed: " + (e.message || e) }); }
          try {
            await store.run("message.add", {
              step_id: stepState.row.id,
              seq: nextSeq(),
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
      let permission = permissionFor(request.permissions, name);
      if (tool && tool.group === "fs" && tool.mode === "write") {
        permission = resolveFsPermissionForPaths(
          request.permissions,
          request.fsPolicy,
          name,
          fsPathsForTool(name, args),
          cwd,
        );
      }
      let decision;
      if (permission === "ask") {
        decision = await core.interactions.requestApproval({ agent, callId, name, args, permission });
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
        signal: handle.signal,
        sessionId,
        callId,
        toolName: name,
        goals: core.goals,
        isPlanMode: () => agent.planPolicyActive(),
        reviewPlan: (plan) => core.interactions.requestPlanReview({ agent, callId, plan, sessionId }),
        askUserQuestion: (questions) => core.interactions.requestUserQuestion({ agent, callId, questions }),
        requestApproval: (payload) => core.interactions.requestApproval(Object.assign({ agent }, payload)),
        requestUserJob: (job) => core.interactions.requestUserJob({ agent, callId, sessionId, ...job }),
        killUserJob: (jobId) => core.interactions.killUserJob(jobId),
        store: core.store,
        capabilities: core.capabilities,
        jobs: core.jobs,
        terminals: core.terminals,
        lsp: core.lsp,
        team: core.team,
        schedule: core.schedule,
        a2a: core.a2a,
        browser: core.browser,
        startJob: core.jobs ? (spec) => core.jobs.start({
          ...spec,
          sessionId,
          chatCtx: {
            toolNames: request.toolNames,
            model: request.model,
            effort: request.effort,
            stream: request.stream,
            activity: agent.turn.activity,
            autonomy: agent.turn.autonomy,
          },
          onEvent,
        }) : null,
        emit: onEvent,
      });
      await finish(result, result.isError === true ? "failed" : "succeeded");
    }
    if (persist) { try { await store.run("step.update", { id: stepState.row.id, status: "succeeded" }); }
    catch (e) { onEvent({ type: "error", error: "step.update failed: " + (e.message || e) }); } }
  }
  // 循环只能从内部 return / throw 退出，这里不需要（也不应该）再有兜底分支。
  } catch (err) {
    // 预期内的终止（请求失败/截断/空回复）与真正的未知异常在这里汇合，
    // 都由 reason 区分；异常终止不再发 done，避免把失败伪装成正常回答。
    if (agent.phase && agent.phase.cancelReason) {
      status = "succeeded";
      reason = agent.phase.cancelReason;
    } else {
      status = "failed";
      reason = err instanceof TurnError ? err.reason : "unexpected-exception";
    }
    errorText = String((err && err.message) || err);
    if (persist && turn) {
      try { if (currentStep && currentStep.row) await store.run("step.update", { id: currentStep.row.id, status: "failed" }); } catch (_) {}
      try { await store.run("turn.update", { id: turn.id, status: "failed" }); } catch (_) {}
    }
    return { role: "assistant", content: "", error: errorText, stopReason: reason };
  } finally {
    handle.finish({ status, reason, steps, tools: toolsUsed, durationMs: Date.now() - startedAt });
    if (persist) agent.gates.activeSessions.delete(String(sessionId));
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

const __exports = { runLoop };
export { runLoop };
export default __exports;
