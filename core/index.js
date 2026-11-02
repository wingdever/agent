"use strict";
const fs = require("fs");
const path = require("path");
const { DEFAULT_IDENTITY, assembleSystemPrompt } = require("./system-prompt");
const { readPermissions, permissionFor } = require("./permissions");

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

// 默认工具：核心内置，注册即进入模型可用列表（UI 无需关心实现）


// 底层核心：UI/传输无关，只认「函数名+参数+onEvent 回调」
// 工具注册：扫描项目根 tools/ 下各子目录的 registry.json，加载 entry 指向的实现
const TOOLS_DIR = path.join(__dirname, "..", "tools");
async function loadTools() {
  const map = new Map();
  let dirs;
  try { dirs = await fs.promises.readdir(TOOLS_DIR, { withFileTypes: true }); }
  catch (_) { return map; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let reg;
    try { reg = JSON.parse(await fs.promises.readFile(path.join(TOOLS_DIR, d.name, "registry.json"), "utf8")); }
    catch (_) { continue; }
    if (!reg || !reg.name) continue;
    const entry = reg.entry || "run.js";
    let mod;
    try { mod = require(path.join(TOOLS_DIR, d.name, entry)); }
    catch (e) { console.error("[tools] 加载失败:", reg.name, e.message); continue; }
    const run = mod && (mod.run || (mod.default && mod.default.run));
    if (typeof run !== "function") continue;
    map.set(reg.name, {
      name: reg.name,
      description: reg.description || "",
      parameters: reg.parameters || { type: "object", properties: {}, required: [] },
      type: reg.type || d.name,
      // Optional guidance section contributed to the system prompt.
      prompt: typeof reg.prompt === "string" ? reg.prompt : "",
      run,
    });
  }
  return map;
}

class AgentCore {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.QINIU_API_KEY || "sk-e0f0f3ddf37c57bd75b558376bc015575e1c8c4e7246306e6d3a7286f226e35a";
    this.baseUrl = config.baseUrl || process.env.QINIU_BASE_URL || "https://api.qnaigc.com/v1";
    this.model = config.model || process.env.QINIU_MODEL || "qiniu/conatus-free";
    this.tools = new Map();
    this.pendingApprovals = new Map();
    this._approvalSeq = 0;
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
          return path.resolve(workspace.folder_path);
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
      return { role: "assistant", content, reasoning_content, tool_calls };
    }

    // Streaming (SSE): parse each data: line into deltas + tool calls.
    let buf = "", content = "", reasoning_content = "", acc = {};
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
          const d = (o.choices && o.choices[0] && o.choices[0].delta) || {};
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
    return { role: "assistant", content, reasoning_content, tool_calls };
  }

  async chat({ messages, toolNames, model, onEvent = () => {}, sessionId, stream } = {}) {
    this._onEvent = onEvent;
    try {
    // Apply persisted settings (user/settings.json): provider -> baseUrl/apiKey, model, stream.
    const st = readSettings();
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
    const tools = (toolNames ? toolNames.map((n) => this.tools.get(n)).filter(Boolean) : [...this.tools.values()])
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const store = this.store;
    const persist = !!(sessionId && store);
    const permissions = readPermissions();

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

    // 开启一轮对话轨迹（持久化）：一个 turn 包含多个 step
    // 每个 step = 一次模型请求 + 其响应（agent-request? + model-response(thought?/answer?/tool-call-card*)）
    // request-time：完成上一步全部 tool-call 后，才在下一轮 step 再次请求模型
    let turn = null;
    let stepSeq = 0;
    if (persist) {
      const turns = await store.run("turn.list", { session_id: sessionId });
      turn = await store.run("turn.create", { session_id: sessionId, seq: turns.length, status: "running" });
    }

    for (let r = 0; r < 5; r++) {
      const step = persist ? await store.run("step.create", { turn_id: turn.id, seq: stepSeq++, status: "running" }) : null;
      // 新一轮 step 开始（r=0 由前端 onSend 预建 UI；r>0 由本事件驱动 UI 建立新 step）
      if (r > 0) onEvent({ type: "step-start", seq: r });

      // step 0：只有 session 首轮落 system；触发本轮的用户请求始终落入本步骤
      if (persist && r === 0) {
        if (systemIsNew) {
          await store.run("message.add", { step_id: step.id, seq: 0, role: "system", content: system });
        }
        const lastUser = [...conv].reverse().find((m) => m.role === "user");
        if (lastUser) {
          const content = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
          await store.run("message.add", { step_id: step.id, seq: systemIsNew ? 1 : 0, role: "user", content });
        }
      }

      // 请求模型（request-time：上一步工具已全部执行完才到这里）
      // 错误边界：模型请求失败显式报错并干净收尾，避免冒泡出 chat() 被笼统吞掉
      let a;
      try {
        a = await this._stream({ messages: conv, toolDefs, model: effModel, onEvent, sessionId, stream: effStream });
      } catch (err) {
        onEvent({ type: "error", error: String(err.message || err) });
        if (persist) {
          try { await store.run("step.update", { id: step.id, status: "failed" }); } catch (_) {}
          try { await store.run("turn.update", { id: turn.id, status: "failed" }); } catch (_) {}
        }
        return { role: "assistant", content: "", error: String(err.message || err) };
      }
      conv.push(a);

      // 记录本轮助手回复与（可能的）工具调用（首轮有 system 时整体后移一位）
      const assistantSeq = r === 0 ? (systemIsNew ? 2 : 1) : 0;
      let assistantMsg = null;
      const callIds = [];
      if (persist) {
        assistantMsg = await store.run("message.add", { step_id: step.id, seq: assistantSeq, role: "assistant", content: a.content || "", thought: a.reasoning_content || "" });
        if (a.tool_calls) {
          for (let i = 0; i < a.tool_calls.length; i++) {
            const tc = a.tool_calls[i];
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
      }

      if (!a.tool_calls) {
        onEvent({ type: "done", message: a });
        if (persist) {
          await store.run("step.update", { id: step.id, status: "succeeded" });
          await store.run("turn.update", { id: turn.id, status: "succeeded" });
        }
        return a;
      }

      // 执行本轮全部 tool-call（需用户授权），完成后再回到循环顶部请求模型
      for (let i = 0; i < a.tool_calls.length; i++) {
        const call = a.tool_calls[i];
        const tool = this.tools.get(call.function.name);
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) { }
        const callType = tool ? tool.type : "unknown";

        // Permissions come from user/permissions.json: allow executes directly,
        // deny refuses without asking, ask waits for the user. Every path emits
        // approval-request so the UI always has the card's approval element.
        const permission = permissionFor(permissions, call.function.name);
        let decision;
        if (permission === "ask") {
          decision = await this.requestApproval({ callId: call.id, name: call.function.name, args, permission });
        } else {
          onEvent({ type: "approval-request", callId: call.id, name: call.function.name, arguments: args, permission });
          decision = permission === "allow" ? "approve" : "deny";
        }
        if (decision !== "approve") {
          const denied = { error: permission === "deny" ? "permission denied" : "user denied" };
          onEvent({ type: "tool_result", id: call.id, name: call.function.name, result: denied });
          if (persist && callIds[i] != null) {
            await store.run("call.update", { id: callIds[i], status: "denied", result: denied });
            await store.run("message.add", { step_id: step.id, seq: assistantSeq + 1 + i, role: "tool", content: JSON.stringify(denied) });
          }
          conv.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(denied) });
          continue;
        }

        // 授权通过：执行工具
        let result;
        try {
          onEvent({ type: "tool_call", id: call.id, name: call.function.name, arguments: args });
          result = tool ? await tool.run(args, { cwd, sessionId }) : { error: "unknown tool" };
          onEvent({ type: "tool_result", id: call.id, name: call.function.name, result });
        } catch (e) { result = { error: String(e.message || e) }; onEvent({ type: "tool_result", id: call.id, name: call.function.name, result }); }
        // 先把结果写进对话历史，确保下一轮 _stream 必带工具结果回传模型（不受持久化失败影响）
        // 纯文本结果原样回传（read 的模型面向信封）；其余工具继续用 JSON。
        const toolContent = typeof result === "string" ? result : JSON.stringify(result);
        conv.push({ role: "tool", tool_call_id: call.id, content: toolContent });
        // 持久化隔离：单项失败仅告警，不阻断把结果回传模型
        if (persist && callIds[i] != null) {
          try { await store.run("call.update", { id: callIds[i], status: result && result.error ? "failed" : "succeeded", result }); }
          catch (e) { onEvent({ type: "error", error: "call.update failed: " + (e.message || e) }); }
          try { await store.run("message.add", { step_id: step.id, seq: assistantSeq + 1 + i, role: "tool", content: toolContent }); }
          catch (e) { onEvent({ type: "error", error: "message.add failed: " + (e.message || e) }); }
        }
      }
      if (persist) { try { await store.run("step.update", { id: step.id, status: "succeeded" }); }
      catch (e) { onEvent({ type: "error", error: "step.update failed: " + (e.message || e) }); } }
    }

    const last = conv[conv.length - 1];
    onEvent({ type: "done", message: last });
    if (persist) await store.run("turn.update", { id: turn.id, status: "failed" });
    return last;
    } finally {
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
    default: throw new Error("unknown fn: " + fn);
  }
}

// 创建核心实例，并挂载数据持久化存储（pgmicro，单文件 ./data/store.db）
async function createCore(config = {}) {
  const core = new AgentCore(resolveDefaultFromProviders(config));
  core.tools = await loadTools();
  const { createStore } = await import("./storage/store.mjs");
  core.store = await createStore();

  return core;
}

module.exports = { AgentCore, createCore, handleCall };
