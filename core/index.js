"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_IDENTITY, assembleSystemPrompt } = require("./system-prompt");
const { readPermissions, permissionFor } = require("./permissions");
const { readFsPolicy, resolveFsPermission } = require("./fs-policy");
const {
  resolveConfig: resolveTranslateConfig,
  shouldTranslateUser,
  shouldTranslateAssistant,
  translateText,
} = require("./translation");

// user/providers.json：用户侧供应者配置，含 base_url / api_key / models。
// 当调用方未显式提供 model 时，作为默认模型来源。
const PROVIDERS_FILE = path.join(__dirname, "..", "user", "providers.json");
const SETTINGS_FILE = path.join(__dirname, "..", "user", "settings.json");

function readSettings() {  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (_) { return {}; }}
function writeSettings(patch) {  const cur = readSettings();  const next = Object.assign({}, cur, patch || {});  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));  return next;}
function resolveProvider(name) {  if (!name) return null;  let providers;  try { providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); } catch (_) { return null; }  if (!Array.isArray(providers)) return null;  const p = providers.find((x) => x.name === name);  if (!p) return null;  const models = Array.isArray(p.models) ? p.models : [];  const model = models.length ? (models[0].name || models[0]) : null;  return { baseUrl: p.base_url, apiKey: p.api_key, model };}

// 调用方未显式指定 model 时，从 user/providers.json 取首个含模型的供应者作为默认：
// 采用其第一个模型，并在调用方未显式给出 baseUrl/apiKey 时一并继承该供应者配置。
function resolveDefaultFromProviders(config = {}) {
  if (config.model) return config;
  let providers;
  try {
    providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  } catch (_) {
    return config; // 文件缺失/损坏则退回构造内的内置默认
  }
  if (!Array.isArray(providers) || !providers.length) return config;
  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    const model = models.length ? (models[0].name || models[0]) : null;
    if (!model) continue;
    return {
      ...config,
      model,
      baseUrl: config.baseUrl || provider.base_url,
      apiKey: config.apiKey || provider.api_key,
    };
  }
  return config;
}

// Tool runtime: registry, argument validation, and text/meta result shaping.
const { loadTools } = require("./tools/registry");
const { validateToolArgs, runTool } = require("./tools/executor");
const { errorResult } = require("./tools/result");
const { reset: resetTodos } = require("./todo-state");
const { createGoalService } = require("./goals");
const planMode = require("./plan-mode");

function firstHeading(plan) {
  for (const line of String(plan == null ? "" : plan).split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return "";
}

// 终止原因：把"预期内的结束"（请求失败/截断/空回复）与真正的未知异常区分开，
// 统一由 chat() 的 catch/finally 记录并对外发 turn-end。
class TurnError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "TurnError";
    this.reason = reason;
  }
}

// Workspaces created through the web folder picker only carry the selected
// folder name (browsers do not expose its parent path). Resolve such relative
// names against the app cwd, the project folder name, the home directory, and
// the parent directory; an unknown folder falls back to the process cwd.
function isDirectory(folder) {
  try { return fs.statSync(folder).isDirectory(); } catch (_) { return false; }
}

function workspaceFolderCandidates(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return [];
  if (path.isAbsolute(text)) return [path.resolve(text)];
  const candidates = [path.resolve(process.cwd(), text)];
  if (path.basename(process.cwd()) === text) candidates.push(process.cwd());
  candidates.push(path.resolve(os.homedir(), text));
  candidates.push(path.resolve(process.cwd(), "..", text));
  return [...new Set(candidates)];
}

function resolveWorkspaceFolder(raw) {
  for (const candidate of workspaceFolderCandidates(raw)) {
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

class AgentCore {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.QINIU_API_KEY || "sk-e0f0f3ddf37c57bd75b558376bc015575e1c8c4e7246306e6d3a7286f226e35a";
    this.baseUrl = config.baseUrl || process.env.QINIU_BASE_URL || "https://api.qnaigc.com/v1";
    this.model = config.model || process.env.QINIU_MODEL || "qiniu/conatus-free";
    this.tools = new Map();
    this.pendingApprovals = new Map();
    this._approvalSeq = 0;
    this.pendingQuestions = new Map();
    this._questionSeq = 0;
    this.pendingPlanReviews = new Map();
    this._planReviewSeq = 0;
    this.pendingUserJobs = new Map();
    this._userJobSeq = 0;
    this.userJobs = new Map();
    this.goals = null;
    this._onEvent = () => {};
  }

  // 请求用户授权执行某工具调用：发 approval-request 事件并挂起，直至 approve() 唤醒。
  // callId 绑定到对应的 tool call 卡片，id 只用于回传审批结果。
  requestApproval({ callId, name, args, permission = "ask" }) {
    return new Promise((resolve) => {
      const id = (this._approvalSeq = (this._approvalSeq || 0) + 1);
      this.pendingApprovals.set(id, resolve);
      this._onEvent({ type: "model-http-status", state: "on-wait" });
      this._onEvent({ type: "approval-request", id, callId, name, arguments: args, permission });
    });
  }

  approve(id, decision) {
    const key = Number(id);
    const fn = this.pendingApprovals.get(key);
    if (!fn) return false;
    this.pendingApprovals.delete(key);
    fn(decision);
    return true;
  }

  // ask_user_question: emit the questions, then block until the UI submits a
  // batch. One answer item per question; a skipped question is empty selected
  // with no custom, matching DSH's answer shape.
  requestUserQuestion({ callId, questions }) {
    const list = Array.isArray(questions) ? questions : [];
    return new Promise((resolve) => {
      const id = (this._questionSeq = (this._questionSeq || 0) + 1);
      this.pendingQuestions.set(id, { resolve, questions: list, callId });
      this._onEvent({ type: "model-http-status", state: "on-wait" });
      this._onEvent({ type: "ask-user-question", id, callId, name: "ask_user_question", questions: list });
    });
  }

  answerQuestions(id, rawAnswers) {
    const key = Number(id);
    const pending = this.pendingQuestions.get(key);
    if (!pending) return false;
    this.pendingQuestions.delete(key);
    const submitted = Array.isArray(rawAnswers) ? rawAnswers : [];
    const answers = pending.questions.map((question) => {
      const found = submitted.find((answer) => answer && answer.id === question.id) || {};
      const selected = Array.isArray(found.selected)
        ? found.selected.filter((value) => typeof value === "string")
        : [];
      const custom = typeof found.custom === "string" && found.custom.trim()
        ? found.custom
        : undefined;
      return { id: question.id, selected, ...(custom !== undefined ? { custom } : {}) };
    });
    pending.resolve({ answers });
    return true;
  }

  setPlanMode(sessionId, active) {
    const value = planMode.setActive(sessionId, active);
    this._onEvent({ type: "plan-mode", active: value });
    return value;
  }

  // exit_plan_mode: show the markdown plan, then block until the UI approves
  // (leave plan mode) or keeps planning with optional feedback.
  requestPlanReview({ callId, plan, sessionId }) {
    return new Promise((resolve) => {
      const id = (this._planReviewSeq = (this._planReviewSeq || 0) + 1);
      this.pendingPlanReviews.set(id, { resolve, sessionId });
      this._onEvent({ type: "model-http-status", state: "on-wait" });
      this._onEvent({
        type: "plan-review",
        id,
        callId,
        plan,
        title: firstHeading(plan) || "Plan",
      });
    });
  }

  answerPlanReview(id, payload = {}) {
    const key = Number(id);
    const pending = this.pendingPlanReviews.get(key);
    if (!pending) return false;
    this.pendingPlanReviews.delete(key);
    const approved = payload.approved === true;
    const feedback = typeof payload.feedback === "string" ? payload.feedback : "";
    if (approved) this.setPlanMode(pending.sessionId, false);
    pending.resolve({ approved, feedback });
    return true;
  }

  // request_user_job: create a user job, emit the task card, and block until the
  // user reports back (or cancels). Mirrors requestUserQuestion but also keeps a
  // job record so job_output / job_list / job_kill can recall it later. The
  // record lives in memory (this.userJobs) and, when a session store exists, is
  // mirrored there.
  requestUserJob({ callId, description, title, sessionId }) {
    return new Promise((resolve) => {
      this._userJobSeq = (this._userJobSeq || 0) + 1;
      const jobId = "ujob_" + Date.now().toString(36) + "_" + this._userJobSeq.toString(36);
      const record = {
        jobId,
        sessionId: sessionId || null,
        status: "pending",
        description: description || "",
        title: title || "",
        result: null,
      };
      this.userJobs.set(jobId, record);
      if (this.store) {
        this.store
          .run("userJob.create", {
            job_id: jobId,
            session_id: sessionId || null,
            status: "pending",
            description: description || "",
            title: title || "",
          })
          .catch((e) => console.error("[core] userJob.create failed:", e.message));
      }
      this.pendingUserJobs.set(jobId, resolve);
      this._onEvent({ type: "model-http-status", state: "on-wait" });
      this._onEvent({ type: "user-job-request", id: jobId, callId, description, title });
    });
  }

  // Resolve a pending request_user_job with the user's report or a cancellation.
  // Returns false when the job id is unknown or already answered.
  answerUserJob(id, payload = {}) {
    const key = String(id);
    const resolve = this.pendingUserJobs.get(key);
    const record = this.userJobs.get(key);
    if (!resolve || !record) return false;
    this.pendingUserJobs.delete(key);
    const cancelled = payload.cancel === true;
    const result = typeof payload.result === "string" ? payload.result : "";
    record.status = cancelled ? "killed" : "completed";
    record.result = result;
    if (this.store) {
      this.store
        .run(cancelled ? "userJob.kill" : "userJob.complete", {
          job_id: key,
          result: cancelled ? undefined : result,
        })
        .catch((e) => console.error("[core] userJob update failed:", e.message));
    }
    this._onEvent({ type: "user-job-update", id: key, status: record.status });
    resolve({ jobId: key, cancelled, result });
    return true;
  }

  // Explicit cancel path (job_kill tool): if the job is still pending, resolve
  // its suspension; otherwise just mark it killed. Returns false for unknown ids.
  killUserJob(jobId) {
    const key = String(jobId);
    const record = this.userJobs.get(key);
    if (!record) return false;
    if (record.status === "pending") return this.answerUserJob(key, { cancel: true });
    if (this.store) this.store.run("userJob.kill", { job_id: key }).catch(() => {});
    record.status = "killed";
    return true;
  }


  listFunctions() {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  _post(payload, sessionId) {
    const { postChatCompletions } = require("./network/http/client");
    return postChatCompletions({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      payload,
      sessionId,
    });
  }

  // Tools resolve relative paths against the conversation's workspace folder.
  // Bare-chat has no session, and a missing/broken workspace link falls back to
  // the process working directory.
  async _resolveCwd(sessionId) {
    if (!sessionId || !this.store) return process.cwd();
    try {
      const session = await this.store.run("session.get", { id: sessionId });
      if (session && session.workspace_id != null) {
        const workspace = await this.store.run("workspace.get", { id: session.workspace_id });
        if (workspace && typeof workspace.folder_path === "string" && workspace.folder_path.trim()) {
          const resolved = resolveWorkspaceFolder(workspace.folder_path);
          if (resolved) {
            const literal = path.resolve(workspace.folder_path);
            if (literal !== resolved) {
              console.warn("[core] workspace folder resolved heuristically:", workspace.folder_path, "->", resolved);
            }
            return resolved;
          }
          console.warn("[core] workspace folder not found:", workspace.folder_path, "-> falling back to", process.cwd());
        }
      }
    } catch (e) {
      // The read tool reports its own I/O failures; a broken lookup only means
      // the round runs from the process directory.
      console.error("[core] resolve cwd failed:", e.message);
    }
    return process.cwd();
  }

  async _stream({ messages, toolDefs, model, onEvent, sessionId, stream = false }) {
    onEvent({ type: "model-http-status", state: "on-post" });
    const { stream: res, cap } = await this._post(
      { model: model || this.model, messages, stream: !!stream, tools: toolDefs },
      sessionId
    );
    onEvent({ type: "model-http-status", state: "on-get", status: cap.status });
    const { trackCapture } = require("./network/http/client");
    trackCapture(res, cap);

    if (!stream) {
      // Non-streaming: read the full JSON response and extract the message.
      let raw = "";
      await new Promise((resolve, reject) => {
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", resolve);
        res.on("error", reject);
      });
      let json;
      try { json = JSON.parse(raw); }
      catch (e) { throw new Error("bad JSON response: " + raw.slice(0, 400)); }
      const choice = (json.choices && json.choices[0]) || {};
      const msg = choice.message || {};
      const content = msg.content || "";
      const reasoning_content = msg.reasoning_content || "";
      const tool_calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
        ? msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: (tc.function && tc.function.name) || "", arguments: (tc.function && tc.function.arguments) || "" },
          }))
        : undefined;
      if (reasoning_content) onEvent({ type: "reasoning", delta: reasoning_content });
      if (content) onEvent({ type: "token", delta: content });
      return { role: "assistant", content, reasoning_content, tool_calls, finish_reason: choice.finish_reason || null };
    }

    // Streaming (SSE): parse each data: line into deltas + tool calls.
    let buf = "", content = "", reasoning_content = "", acc = {}, finishReason = null;
    await new Promise((resolve, reject) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line.indexOf("data:") !== 0) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let o; try { o = JSON.parse(data); } catch (_) { continue; }
          const choice = (o.choices && o.choices[0]) || {};
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const d = choice.delta || {};
          if (d.reasoning_content) { reasoning_content += d.reasoning_content; onEvent({ type: "reasoning", delta: d.reasoning_content }); }
          if (d.content) { content += d.content; onEvent({ type: "token", delta: d.content }); }
          if (d.tool_calls) for (const tc of d.tool_calls) {
            const k = tc.index;
            if (!acc[k]) acc[k] = { id: tc.id, name: (tc.function && tc.function.name) || "", args: "" };
            if (tc.id) acc[k].id = tc.id;
            if (tc.function && tc.function.name) acc[k].name = tc.function.name;
            if (tc.function && tc.function.arguments) acc[k].args += tc.function.arguments;
          }
        }
      });
      res.on("end", resolve); res.on("error", reject);
    });
    const tool_calls = Object.keys(acc).length
      ? Object.keys(acc).map((k) => ({ id: acc[k].id, type: "function", function: { name: acc[k].name, arguments: acc[k].args } }))
      : undefined;
    return { role: "assistant", content, reasoning_content, tool_calls, finish_reason: finishReason };
  }

  async chat({ messages, toolNames, model, onEvent = () => {}, sessionId, stream } = {}) {
    this._onEvent = onEvent;
    const store = this.store;
    const persist = !!(sessionId && store);
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
    let effModel = model || st.model || this.model;
    if (st.provider) {
      const p = resolveProvider(st.provider);
      if (p) {
        this.baseUrl = p.baseUrl;
        this.apiKey = p.apiKey;
        if (!effModel) effModel = p.model;
      }
    }
    // Deterministic schema/guidance order: registration order is a filesystem artifact.
    const tools = (toolNames
      ? toolNames.map((n) => this.tools.get(n)).filter(Boolean)
      : [...this.tools.values()].filter((t) => t.defaultVisible !== false))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const permissions = readPermissions();
    const fsPolicy = readFsPolicy();

    // The system prompt belongs to the session's first turn only: it is
    // assembled once, stored once, and displayed once. Later turns reuse the
    // stored text and neither persist nor emit it again. Requests still carry
    // it every time because Chat Completions is stateless.
    const cwd = await this._resolveCwd(persist ? sessionId : null);
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
    const conv = [{ role: "system", content: system }, ...messages];
    // Replace only the last user turn with its English translation. Earlier
    // turns are already English in the persisted history.
    if (translatedUser != null && conv.length > 1) {
      const lastIndex = conv.length - 1;
      conv[lastIndex] = Object.assign({}, conv[lastIndex], { content: translatedUser });
    }

    // 开启一轮对话轨迹（持久化）：一个 turn 包含多个 step
    // 每个 step = 一次模型请求 + 其响应（agent-request? + model-response(thought?/answer?/tool-call-card*)）
    // request-time：完成上一步全部 tool-call 后，才在下一轮 step 再次请求模型
    let stepSeq = 0;
    if (persist) {
      const turns = await store.run("turn.list", { session_id: sessionId });
      turn = await store.run("turn.create", { session_id: sessionId, seq: turns.length, status: "running" });
    }

    // 终止条件：模型不再返回 tool_calls 才算本轮完成。与 DSH 的 agent loop 一致，
    // 这里不设步数上限 —— 是否继续由模型决定，而不是被一个硬编码的 5 掐断。
    for (let r = 0; ; r++) {
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
      }

      // 请求模型（request-time：上一步工具已全部执行完才到这里）
      // Plan-mode guidance is request-scoped: the stored system prompt stays
      // stable, while every step in plan mode carries the policy. exit_plan_mode
      // flips the state off before the next step, so the policy disappears then.
      conv[0].content = system + (planMode.isActive(sessionId) ? "\n\n" + planMode.POLICY : "");
      // 错误边界：模型请求失败转成 TurnError，由外层统一记录 reason=model-request-error
      let a;
      try {
        a = await this._stream({ messages: conv, toolDefs, model: effModel, onEvent, sessionId, stream: effStream });
      } catch (err) {
        throw new TurnError("model-request-error", String(err.message || err));
      }
      // finish_reason 属于传输层元数据，不能混进后续请求的 messages
      const message = { role: "assistant", content: a.content, reasoning_content: a.reasoning_content, tool_calls: a.tool_calls };
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
                category: (this.tools.get(tc.function && tc.function.name) || {}).type || "unknown",
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
        const tool = this.tools.get(name);

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
          decision = await this.requestApproval({ callId, name, args, permission });
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
          goals: this.goals,
          isPlanMode: () => planMode.isActive(sessionId),
          reviewPlan: (plan) => this.requestPlanReview({ callId, plan, sessionId }),
          askUserQuestion: (questions) => this.requestUserQuestion({ callId, questions }),
          requestApproval: (payload) => this.requestApproval(payload),
          requestUserJob: (job) => this.requestUserJob({ callId, sessionId, ...job }),
          killUserJob: (jobId) => this.killUserJob(jobId),
          store: this.store,
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

  // 拉取供应者远端模型列表（OpenAI 兼容 /models），用于辅助新增模型；走 Node 侧请求，绕开渲染层 CORS
  async fetchProviderModels(baseurl, apikey) {
    if (!baseurl) throw new Error("缺少 baseurl");
    const { fetchModels } = require("./network/http/client");
    return fetchModels(baseurl, apikey);
  }
}

// 统一的「函数分发」：各传输层只负责把通道里的请求转成这次调用
async function handleCall(core, { fn, params = {}, onEvent = () => {} } = {}) {
  switch (fn) {
    case "chat": return await core.chat(Object.assign({ onEvent }, params));
    case "settings": {      if (params.op === "get") return readSettings();      if (params.op === "set") return writeSettings(params.payload);      if (params.op === "providers") {        try { return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); } catch (_) { return []; }      }      throw new Error("unknown settings op: " + params.op);    }
    case "listFunctions": return core.listFunctions();
    case "storage": {
      if (!core.store) throw new Error("storage not initialized");
      return await core.store.run(params.op, params.payload || {});
    }
    case "fetchModels":
      return await core.fetchProviderModels(params.baseurl, params.apikey);
    case "approval":
      return core.approve(params.id, params.decision);
    case "answerQuestions":
      return core.answerQuestions(params.id, params.answers);
    case "answerPlanReview":
      return core.answerPlanReview(params.id, params);
    case "planMode": {
      const sid = params.session_id;
      if (sid == null || sid === "") throw new Error("planMode requires session_id");
      if (params.op === "get") return { active: planMode.isActive(sid) };
      if (params.op === "set") return { active: planMode.setActive(sid, params.active === true) };
      throw new Error("unknown planMode op: " + params.op);
    }
    default: throw new Error("unknown fn: " + fn);
  }
}

// 创建核心实例，并挂载数据持久化存储（pgmicro，单文件 ./data/store.db）
async function createCore(config = {}) {
  const core = new AgentCore(resolveDefaultFromProviders(config));
  core.tools = await loadTools();
  const { createStore } = await import("./storage/store.mjs");
  core.store = await createStore();
  core.goals = createGoalService(core.store);

  return core;
}

module.exports = { AgentCore, createCore, handleCall, resolveWorkspaceFolder };
