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
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  _post(payload, sessionId, baseUrl, apiKey) {
    const { postChatCompletions } = require("./network/http/client");
    return postChatCompletions({
      baseUrl: baseUrl || this.baseUrl,
      apiKey: apiKey || this.apiKey,
      payload,
      sessionId,
    });
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

  // @引用解析：把 UI 传来的 references 解析为可注入对话的上下文文本块。
  // 支持：{ type: "file", path } 读取本地文件；{ type: "session", id } 摘录历史会话。
  async _resolveReferences(references, sessionId) {
    const MAX_FILE = 20000; // 单文件上限，避免超长上下文
    const parts = [];
    for (const ref of references) {
      if (!ref || typeof ref !== "object") continue;
      if (ref.type === "file" && typeof ref.path === "string") {
        try {
          const abs = path.resolve(ref.path);
          const stat = fs.statSync(abs);
          if (stat.isDirectory()) { parts.push(`[引用目录] ${ref.path}（目录，未读取内容）`); continue; }
          const content = fs.readFileSync(abs, "utf8");
          const trimmed = content.length > MAX_FILE ? content.slice(0, MAX_FILE) + `\n…(截断，原 ${content.length} 字符)` : content;
          parts.push(`[引用文件] ${ref.path}\n\`\`\`\n${trimmed}\n\`\`\``);
        } catch (e) {
          parts.push(`[引用文件] ${ref.path}（读取失败：${e.message}）`);
        }
      } else if (ref.type === "session" && ref.id != null) {
        try {
          const tree = await this.store.run("session.trajectory", { session_id: ref.id });
          const name = (ref.name || ("会话 " + ref.id));
          let excerpt = "";
          let turns = 0, steps = 0, calls = 0;
          (tree || []).forEach((t) => { turns++; (t.steps || []).forEach((s) => { steps++; (s.calls || []).forEach((c) => { calls++; excerpt += `- 工具 ${c.name}: ${String(c.description || c.arguments || "").slice(0, 200)}\n`; }); if (s.messages) s.messages.forEach((m) => { if (m.content && m.role === "user") excerpt += `用户: ${String(m.content).slice(0, 300)}\n`; if (m.content && m.role === "assistant") excerpt += `助手: ${String(m.content).slice(0, 300)}\n`; }); }); });
          parts.push(`[引用会话] ${name}（${turns} turns / ${steps} steps / ${calls} 工具调用）\n${excerpt.slice(0, MAX_FILE)}`);
        } catch (e) {
          parts.push(`[引用会话] ${ref.id}（读取失败：${e.message}）`);
        }
      }
    }
    return parts.length ? "以下为本次对话的引用上下文，请基于其内容回答：\n\n" + parts.join("\n\n") : "";
  }

  // 把底层模型的 usage 对象标准化后上报（兼容字段缺失 / 不同厂商命名）。
  // cached_tokens 可能嵌在 prompt_tokens_details 内，也可能直接给顶层。
  _emitUsage(onEvent, raw) {
    if (!raw || typeof raw !== "object") return;
    const details = raw.prompt_tokens_details || {};
    const cached = (typeof raw.cached_tokens === "number") ? raw.cached_tokens
      : (typeof details.cached_tokens === "number" ? details.cached_tokens : null);
    onEvent({
      type: "usage",
      promptTokens: raw.prompt_tokens != null ? raw.prompt_tokens : null,
      completionTokens: raw.completion_tokens != null ? raw.completion_tokens : null,
      totalTokens: raw.total_tokens != null ? raw.total_tokens : null,
      cachedTokens: cached,
    });
  }

  async _stream({ messages, toolDefs, model, onEvent, sessionId, stream = false, maxTokens, baseUrl, apiKey, effort }) {
    onEvent({ type: "model-http-status", state: "on-post" });
    const payload = { model: model || this.model, messages, stream: !!stream, tools: toolDefs };
    // 摘要调用使用 DSH 同款生成上限（8192）；普通对话不带 max_tokens。
    if (maxTokens != null) payload.max_tokens = maxTokens;
    // 推理等级（DSH effort-selector）按 provider 的 reasoning_param 翻译为 provider 字段：
    //   none（关闭推理）-> reasoning_param==="thinking" 时发 {"thinking":{"type":"disabled"}}；
    //                     否则发 {"reasoning_effort":"none"}（radeon / OpenAI 等原生关闭档）
    //   其他等级        -> reasoning_param!=="none" 时发 {"reasoning_effort":"xxx"}
    // 摘要调用显式传 effort:null（DSH 的 summarization 请求不带 effort）。
    // 兼容旧值 "off"：与 "none" 同义（历史 settings.effort 可能为 "off"）。
    const effectiveEffort = effort === undefined ? this.effort : effort;
    if (effectiveEffort) {
      const rp = this.reasoningParamFor(baseUrl || this.baseUrl);
      if (effectiveEffort === "none" || effectiveEffort === "off") {
        if (rp === "thinking") payload.thinking = { type: "disabled" };
        else if (rp !== "none") payload.reasoning_effort = "none";
      } else if (rp !== "none") {
        payload.reasoning_effort = effectiveEffort;
      }
    }
    const { stream: res, cap } = await this._post(payload, sessionId, baseUrl, apiKey);
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
      // 上报 token 用量（非流式响应直接在 json.usage）；同时把标准化 usage
      // 返回给 chat()，供 token-meter 记录 provider usage 锚点。
      if (json.usage) this._emitUsage(onEvent, json.usage);
      return {
        role: "assistant", content, reasoning_content, tool_calls,
        finish_reason: choice.finish_reason || null,
        usage: json.usage ? tokenMeter.normalizeUsage(json.usage) : null,
      };
    }

    // Streaming (SSE): parse each data: line into deltas + tool calls.
    let buf = "", content = "", reasoning_content = "", acc = {}, finishReason = null, lastUsage = null;
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
          if (o.usage) lastUsage = o.usage;  // 用量通常随最后一个 chunk 下发
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
      res.on("end", () => { if (lastUsage) this._emitUsage(onEvent, lastUsage); resolve(); }); res.on("error", reject);
    });
    const tool_calls = Object.keys(acc).length
      ? Object.keys(acc).map((k) => ({ id: acc[k].id, type: "function", function: { name: acc[k].name, arguments: acc[k].args } }))
      : undefined;
    return {
      role: "assistant", content, reasoning_content, tool_calls, finish_reason: finishReason,
      usage: lastUsage ? tokenMeter.normalizeUsage(lastUsage) : null,
    };
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
  async _surfaceNodes(sessionId) {
    const surface = await this.store.run("session.surface", { session_id: sessionId });
    return surface.nodes.map((node) => ({
      seq: node.seq,
      id: node.kind === "checkpoint" ? node.seq : node.id,
      turnSeq: node.turnSeq == null ? null : Number(node.turnSeq),
      checkpoint: node.kind === "checkpoint",
      role: node.message.role,
      tool_calls: node.message.tool_calls,
      tokens: compaction.estimateMessageTokens(node.message),
      message: node.message,
    }));
  }

  // Request messages from the replayed surface + the caller's pending tail
  // (current user message or a not-yet-persisted reference block).
  async _requestMessages(sessionId, system, pending) {
    const nodes = await this._surfaceNodes(sessionId);
    return [{ role: "system", content: system }, ...nodes.map((node) => node.message), ...(pending || [])];
  }

  // One-shot summarization replay: the conversation's own system prompt, tools,
  // and the selected span, with DSH's compaction directive appended as the final
  // user message (prefix-cache reuse). Only text is accepted back.
  async _summarizeMessages({ sessionId, system, toolDefs, input, target }) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    for (const message of input) messages.push(message);
    messages.push({ role: "user", content: compaction.COMPACTION_INSTRUCTION });
    const answer = await this._stream({
      messages,
      toolDefs: toolDefs || [],
      model: target.model,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      effort: null,
      onEvent: () => {}, // never leak the summary into the live answer stream
      sessionId,
      stream: false,
      maxTokens: compaction.SUMMARY_MAX_TOKENS,
    });
    if (Array.isArray(answer.tool_calls) && answer.tool_calls.length) {
      throw new Error("summarization attempted a tool call");
    }
    const text = String(answer.content || "").trim();
    if (!text) throw new Error("summarization produced no text summary content");
    return text;
  }

  // Model-free pruning of oversized tool results (DSH compaction-tool-result-pruner
  // defaults). Original message rows are untouched; history assembly substitutes.
  async _pruneToolResults(sessionId) {
    const rows = await this.store.run("toolResultPrune.list", { session_id: sessionId });
    let count = 0;
    let charsRemoved = 0;
    for (const row of rows) {
      const pruned = compaction.pruneToolResultText(row.content);
      if (!pruned) continue;
      await this.store.run("toolResultPrune.save", {
        message_id: row.message_id,
        content: pruned.content,
        chars_before: pruned.charsBefore,
        chars_after: pruned.charsAfter,
      });
      count += 1;
      charsRemoved += pruned.charsBefore - pruned.charsAfter;
    }
    return { count, charsRemoved };
  }

  // Record the DSH usage anchor after one successful response.
  async _recordTokenAnchor({ sessionId, model, system, tools, messages, assistant, usage }) {
    if (!this.store || !sessionId) return null;
    try {
      const anchor = tokenMeter.anchorFrom({ messages, assistant, system, tools, model, usage });
      return await this.store.run("tokenAnchor.save", {
        session_id: sessionId,
        header_key: anchor.headerKey,
        header_tokens: anchor.headerTokens,
        input_tokens: anchor.inputTokens,
        assistant_tokens: anchor.assistantTokens,
        usage_total: anchor.usageTotal,
      });
    } catch (error) {
      console.warn("[token-meter] anchor save failed:", (error && error.message) || error);
      return null;
    }
  }

  // One compaction transaction in DSH's event format:
  //   compaction/start -> compaction/summary -> user/message(surfaceOp:replace) -> compaction/end
  // The start row is the durable lock until the end row; a failed summary closes
  // with end{error} and leaves the surface untouched.
  async _runCompaction({ sessionId, trigger, surface, boundary, turn, system, toolDefs, target, onEvent = () => {} }) {
    const boundaryIdx = surface.findIndex((node) => node.seq === boundary.seq);
    if (boundaryIdx < 0) return { ok: false, error: "selected surface node is gone" };
    const shadowed = surface.slice(0, boundaryIdx + 1);
    if (!shadowed.length) return { ok: false, error: "no compactable history yet" };
    const input = shadowed.map((node) => this._cleanMessage(node.message));
    const tokensBefore = shadowed.reduce((total, node) => total + node.tokens, 0);
    const shadowedSeqs = shadowed.map((node) => node.seq);
    const shadowedRange = { start: shadowed[0].seq, end: boundary.seq };
    const turnSeqs = new Set(
      shadowed.filter((node) => !node.checkpoint && node.turnSeq != null).map((node) => node.turnSeq),
    );
    const compactionId = crypto.randomUUID();

    let startEvent;
    try {
      startEvent = await this.store.run("compaction.append", {
        session_id: sessionId,
        type: "compaction/start",
        data: { compactionId, trigger, turn: turn == null ? null : turn },
        boot: this.bootId,
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    onEvent({ type: "compaction", phase: "start", trigger, turns: turnSeqs.size, tokensBefore });

    const close = async (error) => {
      try {
        await this.store.run("compaction.append", {
          session_id: sessionId,
          type: "compaction/end",
          data: {
            compactionId,
            turn: turn == null ? null : turn,
            ...(error === undefined ? {} : { error }),
          },
          boot: this.bootId,
        });
      } catch (closeError) {
        console.warn("[compaction] compaction/end append failed:", (closeError && closeError.message) || closeError);
      }
    };

    try {
      const summary = await this._summarizeMessages({ sessionId, system, toolDefs, input, target });
      const framed = compaction.checkpointMessage(summary);
      const tokensAfter = compaction.estimateMessageTokens(framed);
      if (tokensAfter >= tokensBefore) {
        throw new Error("summary is not smaller than the shadowed content (" + tokensAfter + " >= " + tokensBefore + ")");
      }
      const summaryEvent = await this.store.run("compaction.append", {
        session_id: sessionId,
        type: "compaction/summary",
        data: {
          compactionId,
          trigger,
          summary,
          provider: target.provider,
          model: target.model,
          maxTokens: compaction.SUMMARY_MAX_TOKENS,
          shadowedRange,
          shadowedSeqs,
          shadowedTokenCount: tokensBefore,
          tokensAfter,
          turns: turnSeqs.size,
          boundaryMessageId: boundary.checkpoint ? null : boundary.id,
          boundaryTurnSeq: boundary.turnSeq == null ? null : boundary.turnSeq,
        },
        boot: this.bootId,
      });
      await this.store.run("compaction.append", {
        session_id: sessionId,
        type: "user/message",
        data: {
          compactionId,
          content: compaction.frameCheckpoint(summary),
          source: { kind: "plugin", plugin: "compact", compactionId },
          surfaceOp: { op: "replace", start: shadowedRange.start, end: shadowedRange.end },
          boundaryMessageId: boundary.checkpoint ? null : boundary.id,
          boundaryTurnSeq: boundary.turnSeq == null ? null : boundary.turnSeq,
          sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
        },
        boot: this.bootId,
      });
      await close();
      onEvent({ type: "compaction", phase: "done", trigger, turns: turnSeqs.size, tokensBefore, tokensAfter });
      return {
        ok: true,
        compactionId,
        trigger,
        boundary: boundary.seq,
        boundaryTurnSeq: boundary.turnSeq == null ? null : boundary.turnSeq,
        turns: turnSeqs.size,
        tokensBefore,
        tokensAfter,
        summary,
        shadowedSeqs,
        shadowedRange,
      };
    } catch (error) {
      const message = String((error && error.message) || error);
      await close(message);
      onEvent({ type: "compaction", phase: "failed", trigger, error: message });
      return { ok: false, error: message };
    }
  }

  // Manual /compact: idle session only, DSH's retainTokens=0 → keep the last
  // balanced surface unit and compact everything before it.
  async compactSession({ sessionId, model, onEvent = () => {} } = {}) {
    if (!this.store) return { ok: false, error: "storage not initialized" };
    if (!sessionId) return { ok: false, error: "compact requires a session" };
    if (this.activeSessions.has(String(sessionId))) {
      return { ok: false, error: "compact requires an idle session: a turn is running" };
    }
    const key = String(sessionId);
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    this.compacting.set(key, gate);
    try {
      const active = await this.store.run("compaction.active", { session_id: sessionId, boot: this.bootId });
      if (active) return { ok: false, error: "compaction already in progress" };
      const surface = await this._surfaceNodes(sessionId);
      const boundary = compaction.selectTailBoundary(surface);
      if (!boundary) return { ok: false, error: "no compactable history yet" };
      const st = readSettings();
      const target = this._resolveTarget(model);
      const system = await this.store.run("session.prompt", { session_id: sessionId });
      const toolDefs = this._toolDefs(this._selectTools());
      return await this._runCompaction({
        sessionId,
        trigger: "manual",
        surface,
        boundary,
        turn: null,
        system,
        toolDefs,
        target: { ...target, provider: st.provider || null },
        onEvent,
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    } finally {
      this.compacting.delete(key);
      releaseGate();
    }
  }

  // Automatic policy before one model request: prune first, then summarize when
  // still above the pressure threshold (or after a context-overflow rejection).
  async _maybeCompactStep({ sessionId, conv, system, toolDefs, model, turn, trigger = "pressure", pending, onEvent = () => {} }) {
    if (!this.store || !sessionId) return { conv, changed: false };
    const st = readSettings();
    if (st.autoCompact === false) return { conv, changed: false };
    const window = resolveContextWindow({ provider: st.provider, model, settings: st });
    const thresholdTokens = Math.floor(window * compaction.AUTO_THRESHOLD_RATIO);
    const isOverflow = trigger === "context-overflow";
    const pendingMessages = pending ? pending() : [];
    const anchor = await this.store.run("tokenAnchor.get", { session_id: sessionId });
    let measurement = tokenMeter.measure({
      messages: conv.slice(1),
      system,
      tools: toolDefs,
      model,
      anchor,
    });
    if (!isOverflow && measurement.total < thresholdTokens) return { conv, changed: false };

    const active = await this.store.run("compaction.active", { session_id: sessionId, boot: this.bootId });
    if (active) {
      console.warn("[compaction] another compaction holds the lock; skipping automatic pass");
      return { conv, changed: false };
    }
    let current = conv;
    let changed = false;

    // Phase 1: model-free tool-result pruning.
    try {
      const pruned = await this._pruneToolResults(sessionId);
      if (pruned.count > 0) {
        current = await this._requestMessages(sessionId, system, pendingMessages);
        changed = true;
        measurement = tokenMeter.measure({ messages: current.slice(1), system, tools: toolDefs, model, anchor });
        onEvent({ type: "compaction", phase: "prune", trigger, count: pruned.count, charsRemoved: pruned.charsRemoved });
      }
    } catch (error) {
      console.warn("[compaction] tool-result pruning failed:", (error && error.message) || error);
    }
    if (!isOverflow && measurement.total < thresholdTokens) return { conv: current, changed };

    // Phase 2: summarize the span older than the retained tail. The tail budget
    // counts the pending user message so it is never compacted.
    const surface = await this._surfaceNodes(sessionId);
    const boundary = isOverflow
      ? compaction.selectTailBoundary(surface)
      : compaction.selectAutoBoundary(
        surface,
        Math.floor(window * compaction.AUTO_RETAIN_RATIO),
        compaction.estimateMessagesTokens(pendingMessages),
      );
    if (!boundary) return { conv: current, changed };

    const result = await this._runCompaction({
      sessionId,
      trigger,
      surface,
      boundary,
      turn: turn ? turn.seq : null,
      system,
      toolDefs,
      target: { model, baseUrl: this.baseUrl, apiKey: this.apiKey, provider: st.provider || null },
      onEvent,
    });
    if (result.ok) {
      current = await this._requestMessages(sessionId, system, pendingMessages);
      changed = true;
      measurement = tokenMeter.measure({ messages: current.slice(1), system, tools: toolDefs, model, anchor });
      if (!isOverflow && measurement.total >= thresholdTokens) {
        console.warn("[compaction] still above the pressure threshold after one compaction pass (retained tail is over budget)");
      }
    }
    return { conv: current, changed };
  }

  async chat(ctx = {}) {
    // 统一入口：按 AGENT_LOOP_ENGINE 选择 agent-loop 引擎并委托执行。
    // 原 chat() 主循环（已抽离到 core/loops/linear.js），
    // 保证向后兼容与现有测试不退化。第二种 "node-graph" 引擎见 docs/agent-loop-node-graph.md。
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

  return core;
}

module.exports = { AgentCore, createCore, handleCall, resolveWorkspaceFolder, resolveContextWindow };
