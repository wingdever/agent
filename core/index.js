"use strict";
const crypto = require("crypto");
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
const compaction = require("./compaction");
const tokenMeter = require("./token-meter");
const loopsConfig = require("./loops/loops-config");
const { runBareChat } = require("./bare-chat");
const { SkillRegistry, FileSystemSkillProvider, setSkillsRegistry, isUserInvocable, isModelInvocable, isSkillName } = require("./skills");

// M0 重构：将 AgentCore 的流式 / 压缩 / 引用 / token 锚点能力拆为独立模块，
// 类内仅保留转发壳，对外接口（createCore 返回的 core 对象、chat 等）不变。
const streamMod = require("./response-process");
const tokenAnchor = require("./token-anchor");
const compactionRunner = require("./compaction-runner");

// user/providers.json：用户侧供应者配置，含 base_url / api_key / models。
// 当调用方未显式提供 model 时，作为默认模型来源。
const PROVIDERS_FILE = path.join(__dirname, "..", "user", "providers.json");
const SETTINGS_FILE = path.join(__dirname, "..", "user", "settings.json");
const PERMISSIONS_FILE = path.join(__dirname, "..", "user", "permissions.json");
const BASH_POLICY_FILE = path.join(__dirname, "..", "user", "bash-policy.json");
const FS_POLICY_FILE = path.join(__dirname, "..", "user", "fs-policy.json");

function readSettings() {  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (_) { return {}; }}
function writeSettings(patch) {  const cur = readSettings();  const next = Object.assign({}, cur, patch || {});  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));  return next;}

// 权限门控三配置文件（均不入 git，见 docs/tool.md）：
//   permissions.json  -> 工具级档位 default + 每工具 allow/ask/deny
//   bash-policy.json   -> bash 工具内部命令级门控（default + 按 program/args 前缀规则）
//   fs-policy.json     -> 仅 write/edit 的按 path glob 精细规则
function readPermissionFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
function writePermissionFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

// user/providers.json：供应者/模型配置（本机，不入 git）。
// 这是运行时默认模型/baseUrl/apiKey 的真正来源（见 resolveProvider / resolveDefaultFromProviders）。
// schema 允许扩展字段并保持可空：base_url / api_key / description 可空；模型含可选 fee（缺省 "unknown"）。
function readProvidersFile() {
  try {
    var arr = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    if (!Array.isArray(arr)) return [];
    return arr.map(function (p) {
      var out = { name: p.name, base_url: p.base_url || null, api_key: p.api_key || null, description: p.description || null };
      if (p.reasoning_param) out.reasoning_param = p.reasoning_param;
      out.models = (Array.isArray(p.models) ? p.models : []).map(function (m) {
        var mn = (typeof m === "string") ? m : (m && m.name);
        var model = { name: mn, fee: (m && m.fee) || "unknown", enabled: m && m.enabled === true };
        // 保留 effort 元数据（推理等级缓存），供 modelCapabilities 本地命中，避免每次启动拉 /models
        if (m && m.effort && Array.isArray(m.effort.supported_levels)) {
          model.effort = { supported_levels: m.effort.supported_levels.slice(), default_level: m.effort.default_level || null };
        }
        return model;
      });
      return out;
    });
  } catch (_) { return []; }
}
function writeProvidersFile(arr) {
  fs.mkdirSync(path.dirname(PROVIDERS_FILE), { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(arr || [], null, 2));
  return arr || [];
}
function resolveProvider(name) {  if (!name) return null;  let providers;  try { providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); } catch (_) { return null; }  if (!Array.isArray(providers)) return null;  const p = providers.find((x) => x.name === name);  if (!p) return null;  const models = (Array.isArray(p.models) ? p.models : []).filter((m) => m && m.enabled === true);  const model = models.length ? (models[0].name || models[0]) : null;  return { baseUrl: p.base_url, apiKey: p.api_key, model };}

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

// 上下文窗口：优先 providers.json 每模型可选的 context_window，其次
// settings.contextWindow，最后回退 128000。自动压缩与 UI 的占用环共用它。
function resolveContextWindow({ provider, model, settings } = {}) {
  const st = settings || readSettings();
  let providers;
  try { providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); } catch (_) { providers = []; }
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (provider && p && p.name !== provider) continue;
      for (const m of (p && p.models) || []) {
        const name = typeof m === "string" ? m : (m && m.name);
        if (model && name !== model) continue;
        const cw = m && typeof m === "object" ? Number(m.context_window) : NaN;
        if (Number.isFinite(cw) && cw > 0) return Math.floor(cw);
      }
    }
  }
  const fromSettings = Number(st.contextWindow);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return Math.floor(fromSettings);
  return compaction.DEFAULT_CONTEXT_WINDOW;
}

// 终止原因：把"预期内的结束"（请求失败/截断/空回复）与真正的未知异常区分开，
// 统一由 chat() 的 catch/finally 记录并对外发 turn-end。
const { TurnError } = require("./turn-error");

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
    // 正在跑 turn 的会话集合：/compact 只允许在 idle 会话上触发（DSH 的
    // runMaintenance 幂等语义），防止压缩与在途请求交错。
    this.activeSessions = new Set();
    // 手动压缩进行中的会话 -> 完成闸门。DSH 的 runMaintenance 会把压缩期间的
    // 新输入排队；这里让 chat() 等闸门，避免压缩与在途 turn 交错。
    this.compacting = new Map();
    // 进程身份：DSH 用 session/end-seed 忽略上一次生命周期的孤儿 compression/start；
    // 这里把 boot 记在事件上，重启后旧 start 自动不算锁。
    this.bootId = crypto.randomUUID();
    // 当前自主度：由 chat() 的 autonomy 参数注入（supervised | autonomous）。
    // autonomous 下所有 ask 自动 deny（见 docs/agent-mode.md），不挂起等待用户。
    this.autonomy = "supervised";
  }

  isAutonomous() {
    return this.autonomy === "autonomous";
  }

  // 请求用户授权执行某工具调用：发 approval-request 事件并挂起，直至 approve() 唤醒。
  // callId 绑定到对应的 tool call 卡片，id 只用于回传审批结果。
  // autonomous 模式：自动 deny，不挂起（emit autoDenied 供 UI 渲染静态卡）。
  requestApproval({ callId, name, args, permission = "ask" }) {
    if (this.isAutonomous()) {
      this._onEvent({ type: "approval-request", callId, name, arguments: args, permission, autoDenied: true });
      return Promise.resolve("deny");
    }
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
    // autonomous 模式：不等待用户回答，直接返回空答案让模型继续。
    if (this.isAutonomous()) {
      const answers = list.map((q) => ({ id: q.id, selected: [] }));
      return Promise.resolve({ answers });
    }
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
    if (approved) {
      // Defer the real flip to the next in-turn pre-step (loop top) so the rest
      // of the current tool batch stays under plan guidance. Tell the UI to
      // leave now for responsiveness; isActive keeps reporting true until the
      // pending flip, so in-batch tools still carry POLICY.
      planMode.requestExit(pending.sessionId);
      this._onEvent({ type: "plan-mode", active: false });
    }
    pending.resolve({ approved, feedback });
    return true;
  }

  // request_user_job: create a user job, emit the task card, and block until the
  // user reports back (or cancels). Mirrors requestUserQuestion but also keeps a
  // job record so job_output / job_list / job_kill can recall it later. The
  // record lives in memory (this.userJobs) and, when a session store exists, is
  // mirrored there.
  requestUserJob({ callId, description, title, sessionId }) {
    // autonomous 模式：不等待用户委派，直接标记取消让模型继续。
    if (this.isAutonomous()) {
      const jobId = "ujob_" + Date.now().toString(36) + "_" + ((this._userJobSeq = (this._userJobSeq || 0) + 1)).toString(36);
      return Promise.resolve({ jobId, cancelled: true });
    }
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
    // 供 UI 工具查看弹窗（tools-modal）使用：在模型契约字段 name/description/parameters
    // 之外，额外暴露 type（分组用，对应 registry 的 type 字段：fs/web/goal/...）与
    // prompt（工具贡献的 prompt 片段），以及 defaultVisible（默认是否对模型可见）。
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      type: t.type,
      prompt: t.prompt || "",
      defaultVisible: t.defaultVisible,
    }));
  }

  // 按 baseUrl 匹配 user/providers.json 中的 provider，读出其 reasoning_param 配置。
  // reasoning_param 决定 effort 如何翻译为 provider 字段：
  //   "thinking"         -> none 发 {"thinking":{"type":"disabled"}}；其余发 reasoning_effort
  //   "reasoning_effort" -> none 发 {"reasoning_effort":"none"}；其余发 reasoning_effort（OpenAI / 多数兼容网关）
  //   "none"             -> 一律不注入推理参数
  //   缺省               -> "reasoning_effort"（最安全的通用默认：不发送 thinking，避免 400）
  reasoningParamFor(baseUrl) {
    const target = (baseUrl || this.baseUrl || "").replace(/\/$/, "");
    if (!target) return "reasoning_effort";
    const providers = readProvidersFile();
    const p = providers.find((x) => (x.base_url || "").replace(/\/$/, "") === target);
    return (p && p.reasoning_param) || "reasoning_effort";
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

  // usage 上报：委托 core/response-process.js（纯函数，单一职责拆分）。
  _emitUsage(onEvent, raw) {
    return streamMod.emitUsage(onEvent, raw);
  }

  // 模型流式/非流式调用：委托 core/response-process.js（单一职责拆分）。
  async _stream(opts) {
    return streamMod.stream(this, opts);
  }

  // ================= 上下文压缩（DSH compaction 栈） =================

  // Deterministic schema/guidance order: registration order is a filesystem
  // artifact (same ordering as chat()).
  _selectTools(toolNames) {
    return (toolNames
      ? toolNames.map((n) => this.tools.get(n)).filter(Boolean)
      : [...this.tools.values()].filter((t) => t.defaultVisible !== false))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  _toolDefs(tools) {
    return (tools || []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  // Resolve the routed model plus its provider credentials without mutating the
  // core (used by compaction when no chat round is in flight).
  _resolveTarget(modelOverride) {
    const st = readSettings();
    let model = modelOverride || st.model || this.model;
    let baseUrl = this.baseUrl;
    let apiKey = this.apiKey;
    let provider = st.provider || null;
    if (st.provider) {
      const p = resolveProvider(st.provider);
      if (p) {
        baseUrl = p.baseUrl || baseUrl;
        apiKey = p.apiKey || apiKey;
        if (!model) model = p.model;
      }
    }
    return { model, baseUrl, apiKey, provider };
  }

  // Strip surface metadata (event seq / message id / turn seq) before a message
  // reaches the provider; the request body keeps only Chat Completions fields.
  _cleanMessage(message) {
    const clean = { role: message.role, content: message.content };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) clean.tool_calls = message.tool_calls;
    if (message.tool_call_id) clean.tool_call_id = message.tool_call_id;
    return clean;
  }

  // Message-level surface from the event log: append-origin messages with every
  // compaction replacement applied, each node priced with the DSH heuristic.
  // 以下压缩域方法均委托 core/compaction-runner.js（单一职责拆分）。
  async _surfaceNodes(sessionId) {
    return compactionRunner.surfaceNodes(this, sessionId);
  }

  async _requestMessages(sessionId, system, pending) {
    return compactionRunner.requestMessages(this, sessionId, system, pending);
  }

  async _summarizeMessages(opts) {
    return compactionRunner.summarizeMessages(this, opts);
  }

  async _pruneToolResults(sessionId) {
    return compactionRunner.pruneToolResults(this, sessionId);
  }

  async _recordTokenAnchor(opts) {
    return tokenAnchor.recordTokenAnchor(this, opts);
  }

  async _runCompaction(opts) {
    return compactionRunner.runCompaction(this, opts);
  }

  async compactSession(opts) {
    return compactionRunner.compactSession(this, opts);
  }

  async _maybeCompactStep(opts) {
    return compactionRunner.maybeCompactStep(this, opts);
  }

  async chat(ctx = {}) {
    // 统一入口：按显式 session-mode 信号分发。ctx.mode === "bare" 走 bare-chat
    // （无状态、单请求、不落库、无工具）；否则走 agent-loop 引擎（linear / node-graph）。
    // 用显式信号而非 !sessionId：历史上存在「无 sessionId 但仍需工具循环」的 chat()
    // 调用方（persist 只控制是否落库，与工具执行无关），不能靠 sessionId 推断模式。
    // bare-chat 是 session-mode 层，不是第三个 loop 引擎，不进 loops 注册表，
    // 也不是 AGENT_LOOP_ENGINE 的取值（见 docs/agent-mode.md）。
    if (ctx.mode === "bare") return runBareChat(this, ctx);
    // loopEngine 属实现层（如同 AGENT_TRANSPORT），由环境变量配置，不进入用户 settings.json。
    return this._runLoop(ctx);
  }

  // 委托给 loop 引擎注册表（core/loops/index.js）。引擎名来自 AGENT_LOOP_ENGINE 环境变量，
  // 与 transport 层（AGENT_TRANSPORT）一致——均为实现层配置，非用户层。
  async _runLoop(ctx) {
    const { getLoop } = require("./loops");
    const engineName = process.env.AGENT_LOOP_ENGINE;
    const loop = getLoop(engineName);
    return loop.runLoop(this, ctx);
  }


  // 拉取供应者远端模型列表（OpenAI 兼容 /models），用于辅助新增模型；走 Node 侧请求，绕开渲染层 CORS
  async fetchProviderModels(baseurl, apikey) {
    if (!baseurl) throw new Error("缺少 baseurl");
    const { fetchModels } = require("./network/http/client");
    return fetchModels(baseurl, apikey);
  }
  // 返回某模型的推理等级选项（effort）。优先读本地 providers.json 缓存的 effort 元数据
  // （user/providers.json 每模型可带 effort:{supported_levels,default_level}），仅在无缓存时
  // 才现场请求 provider 的 /models 解析（DeepSeek effort.supported_levels / Venice ...）。
  async modelCapabilities({ provider, model } = {}) {
    const { fetchModels } = require("./network/http/client");
    const providers = readProvidersFile();
    // 1) 本地缓存优先：遍历 providers，按模型名匹配到 effort 元数据
    for (const p of (providers || [])) {
      if (provider && p.name !== provider) continue;
      const m = (p.models || []).find((x) => x.name === model);
      if (m && m.effort && Array.isArray(m.effort.supported_levels)) {
        return { model, effort: m.effort.supported_levels, default_level: m.effort.default_level || null };
      }
    }
    // 2) 无缓存：现场拉取（未指定 provider 时跨所有 provider 尝试）
    const candidates = (providers || []).filter((p) => !provider || p.name === provider);
    for (const cand of candidates) {
      try {
        const res = await fetchModels(cand.base_url, cand.api_key);
        const list = res.list || res;
        const hit = list.find((m) => m.id === model);
        if (hit && hit.effort) return { model, effort: hit.effort, default_level: hit.default_level || null };
      } catch (_) {}
    }
    return { model, effort: null, default_level: null };
  }
}

// 统一的「函数分发」：各传输层只负责把通道里的请求转成这次调用
async function handleCall(core, { fn, params = {}, onEvent = () => {} } = {}) {
  switch (fn) {
    case "chat": return await core.chat(Object.assign({ onEvent }, params));
    case "settings": {      if (params.op === "get") return readSettings();      if (params.op === "set") return writeSettings(params.payload);      if (params.op === "providers") {        try { return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); } catch (_) { return []; }      }      throw new Error("unknown settings op: " + params.op);    }
    case "permissions": {
      if (params.op === "get") return {
        permissions: readPermissionFile(PERMISSIONS_FILE, { default: "ask", tools: [] }),
        bashPolicy: readPermissionFile(BASH_POLICY_FILE, { default: "ask", rules: [] }),
        fsPolicy: readPermissionFile(FS_POLICY_FILE, { rules: [] }),
      };
      if (params.op === "permissions.upsert") return writePermissionFile(PERMISSIONS_FILE, params.payload || { default: "ask", tools: [] });
      if (params.op === "bashpolicy.upsert") return writePermissionFile(BASH_POLICY_FILE, params.payload || { default: "ask", rules: [] });
      if (params.op === "fspolicy.upsert") return writePermissionFile(FS_POLICY_FILE, params.payload || { rules: [] });
      throw new Error("unknown permissions op: " + params.op);
    }
    case "providers": {
      if (params.op === "get") return readProvidersFile();
      if (params.op === "upsert") return writeProvidersFile(params.payload || []);
      throw new Error("unknown providers op: " + params.op);
    }
    case "loops": {
      const { loadNodes } = require("./loops/registry");
      const { listEngineNames, DEFAULT_ENGINE } = require("./loops");
      const nodesMap = loadNodes();
      const nodes = [];
      const builtins = [];
      for (const node of nodesMap.values()) {
        nodes.push({ id: node.id, type: node.type, next: node.next, hooks: node.hooks });
        if (node.type === "builtin") builtins.push(node.id);
      }
      const coreNodeIds = nodes.filter((n) => n.type !== "builtin").map((n) => n.id);
      const allNodeIds = nodes.map((n) => n.id);
      const st = readSettings();
      if (params.op === "get" || params.op === "list") {
        return {
          engines: listEngineNames(),
          currentEngine: process.env.AGENT_LOOP_ENGINE || DEFAULT_ENGINE,
          defaultEngine: DEFAULT_ENGINE,
          nodes,
          builtins,
          hooks: loopsConfig.readLoops(),
          translateEnabledInLinear: !!(st.translate && st.translate.enabled),
        };
      }
      if (params.op === "upsert") {
        const hooks = (params.payload && params.payload.hooks) || [];
        loopsConfig.validateHooks(hooks, coreNodeIds, allNodeIds);
        loopsConfig.writeLoops(hooks);
        return { ok: true, hooks };
      }
      throw new Error("unknown loops op: " + params.op);
    }
    case "listFunctions": return core.listFunctions();
    case "skills": {
      // 取代 dsh 的 Remote seam：UI 经 IPC 直接查询本地注册表（见 docs/dev/skill.md 5.7）。
      // 用 isUserInvocable 过滤（仅返回用户可调用入口），映射为 SkillEntry 形状。
      if (params.op === "list") {
        const cwd = params.cwd || process.cwd();
        const skills = core.skills ? (await core.skills.list({ cwd })).filter((s) => isUserInvocable(s)) : [];
        return skills.map((s) => ({
          name: s.name,
          description: s.description,
          whenToUse: s.whenToUse != null ? s.whenToUse : null,
          provider: s.provider != null ? s.provider : "unknown",
          source: s.source != null ? s.source : (s.provider != null ? s.provider : "unknown"),
          modelInvocable: isModelInvocable(s),
        }));
      }
      if (params.op === "get") {
        const cwd = params.cwd || process.cwd();
        const name = params.name;
        if (!isSkillName(name)) throw new Error(`invalid skill name "${name}"`);
        const skill = core.skills ? await core.skills.get(name, { cwd }) : null;
        if (!skill || !isUserInvocable(skill)) throw new Error(`skill "${name}" is not available`);
        return {
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse != null ? skill.whenToUse : null,
          provider: skill.provider != null ? skill.provider : "unknown",
          source: skill.source != null ? skill.source : (skill.provider != null ? skill.provider : "unknown"),
          modelInvocable: isModelInvocable(skill),
          content: skill.content != null ? skill.content : "",
          resourceBase: skill.resourceBase || null,
        };
      }
      throw new Error("unknown skills op: " + params.op);
    }
    case "storage": {
      if (!core.store) throw new Error("storage not initialized");
      return await core.store.run(params.op, params.payload || {});
    }
    case "fs": {
      // 只读文件读取（供 UI 产物预览），有大小上限，不做任何写操作。
      if (params.op === "read") {
        const p = String(params.path || "");
        if (!p) throw new Error("fs.read requires path");
        const MAX = 200000;
        try {
          const stat = fs.statSync(p);
          if (stat.isDirectory()) return { path: p, isDirectory: true, content: "" };
          const size = stat.size;
          const content = fs.readFileSync(p, "utf8");
          return { path: p, isDirectory: false, truncated: size > MAX, content: content.length > MAX ? content.slice(0, MAX) : content };
        } catch (e) { throw new Error("fs.read failed: " + (e.message || e)); }
      }
      throw new Error("unknown fs op: " + params.op);
    }
    case "fetchModels":
      return await core.fetchProviderModels(params.baseurl, params.apikey);
    case "modelCapabilities":
      return await core.modelCapabilities(params);
    case "contextWindow":
      return { model: params.model || null, contextWindow: resolveContextWindow(params) };
    // 手动 /compact：只允许 idle 会话；压缩语义与自动触发共用同一事务。
    case "compact":
      return await core.compactSession({ sessionId: params.session_id, model: params.model, onEvent });
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

  // Skill subsystem: single registry, filesystem provider. The bundled root is the
  // project-root <root>/skills directory (rank 600); see docs/dev/skill.md 3.1/5.1.
  // Config items (customSkillDirs / bundledSkillDir / collectCacheMaxEntries / watch)
  // are read from user/settings.json when present, falling back to the documented
  // defaults (docs/dev/skill.md 5.6).
  const skillCfg = readSettings().skills || {};
  const skillsRegistry = new SkillRegistry({
    logger: console,
    collectCacheMaxEntries: Number.isInteger(skillCfg.collectCacheMaxEntries) ? skillCfg.collectCacheMaxEntries : 128,
  });
  skillsRegistry.registerProvider((control) =>
    new FileSystemSkillProvider(
      {
        includeDefaultRoots: true,
        bundledSkillDir: skillCfg.bundledSkillDir
          ? path.resolve(skillCfg.bundledSkillDir)
          : path.resolve(__dirname, "..", "skills"),
        customSkillDirs: Array.isArray(skillCfg.customSkillDirs) ? skillCfg.customSkillDirs : [],
        watch: skillCfg.watch !== undefined ? !!skillCfg.watch : true,
      },
      { control, warn: (m) => console.warn(m) }
    )
  );
  setSkillsRegistry(skillsRegistry);
  core.skills = skillsRegistry;

  // One-shot subagent runtime (docs/dev/subagent.md). Mounted after store/tools
  // are ready; tools/subagent/run.js reaches it via exec.subagentSpawn.
  const { SubagentRuntime } = require("./subagent-runtime");
  core.subagents = new SubagentRuntime(core);

  return core;
}

module.exports = { AgentCore, createCore, handleCall, resolveWorkspaceFolder, resolveContextWindow };
