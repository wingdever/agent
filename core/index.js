"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// user/providers.json：用户侧供应者配置，含 base_url / api_key / models。
// 当调用方未显式提供 model 时，作为默认模型来源。
const PROVIDERS_FILE = path.join(__dirname, "..", "user", "providers.json");

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

  // 请求用户授权执行某工具调用：发 approval-request 事件并挂起，直至 approve() 唤醒
  requestApproval({ name, args }) {
    return new Promise((resolve) => {
      const id = (this._approvalSeq = (this._approvalSeq || 0) + 1);
      this.pendingApprovals.set(id, resolve);
      this._onEvent({ type: "approval-request", id, name, arguments: args });
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

  _post(payload) {
    return new Promise((resolve, reject) => {
      const base = new URL(this.baseUrl);
      const prefix = base.pathname.replace(/\/$/, "");
      const body = JSON.stringify(payload);
      const req = https.request(
        { method: "POST", hostname: base.hostname, port: base.port || 443, path: prefix + "/chat/completions",
          headers: { Authorization: "Bearer " + this.apiKey, "Content-Type": "application/json", Accept: "text/event-stream", "Content-Length": Buffer.byteLength(body) }, timeout: 60000 },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let d = ""; res.on("data", (c) => (d += c));
            res.on("end", () => reject(new Error("HTTP " + res.statusCode + " " + d.slice(0, 400))));
            return;
          }
          resolve(res);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("超时")));
      req.write(body); req.end();
    });
  }

  async _stream({ messages, toolDefs, model, onEvent }) {
    const res = await this._post({ model: model || this.model, messages, stream: true, tools: toolDefs });
    let buf = "", content = "", acc = {};
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
    return { role: "assistant", content, tool_calls };
  }

  async chat({ messages, toolNames, model, onEvent = () => {}, sessionId } = {}) {
    this._onEvent = onEvent;
    const tools = toolNames ? toolNames.map((n) => this.tools.get(n)).filter(Boolean) : [...this.tools.values()];
    const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const conv = messages.slice();
    const store = this.store;
    const persist = !!(sessionId && store);

    // 开启一轮对话轨迹（持久化）：turn + 首条 step(用户消息)
    let turn = null;
    let stepSeq = 0;
    if (persist) {
      const turns = await store.run("turn.list", { session_id: sessionId });
      turn = await store.run("turn.create", { session_id: sessionId, seq: turns.length, status: "running" });
      const userStep = await store.run("step.create", { turn_id: turn.id, seq: stepSeq++, status: "succeeded" });
      const lastUser = [...conv].reverse().find((m) => m.role === "user");
      if (lastUser) {
        const content = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
        await store.run("message.add", { step_id: userStep.id, seq: 0, role: "user", content });
      }
    }

    for (let r = 0; r < 5; r++) {
      const step = persist ? await store.run("step.create", { turn_id: turn.id, seq: stepSeq++, status: "running" }) : null;
      const a = await this._stream({ messages: conv, toolDefs, model, onEvent });
      conv.push(a);

      // 记录本轮助手回复与（可能的）工具调用
      let assistantMsg = null;
      const callIds = [];
      if (persist) {
        assistantMsg = await store.run("message.add", { step_id: step.id, seq: 0, role: "assistant", content: a.content || "" });
        if (a.tool_calls) {
          for (let i = 0; i < a.tool_calls.length; i++) {
            const tc = a.tool_calls[i];
            let args = {};
            try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { args = {}; }
            const call = await store.run("call.add", {
              reply_id: assistantMsg.content_id,
              seq: i,
              name: (tc.function && tc.function.name) || "unknown",
              type: (this.tools.get(tc.function && tc.function.name) || {}).type || "unknown",
              arguments: args,
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

      // 执行工具调用（需用户授权）并回写结果到持久化轨迹
      for (let i = 0; i < a.tool_calls.length; i++) {
        const call = a.tool_calls[i];
        const tool = this.tools.get(call.function.name);
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) {}
        const callType = tool ? tool.type : "unknown";

        // 每次工具调用都先请求用户授权（HumanControl 前置）
        const decision = await this.requestApproval({ name: call.function.name, args });
        if (decision !== "approve") {
          const denied = { error: "user denied" };
          onEvent({ type: "tool_result", id: call.id, name: call.function.name, result: denied });
          if (persist && callIds[i] != null) {
            await store.run("call.update", { id: callIds[i], status: "denied", result: denied });
            await store.run("message.add", { step_id: step.id, seq: i + 1, role: "tool", content: JSON.stringify(denied), tool_call_id: callIds[i] });
          }
          conv.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(denied) });
          continue;
        }

        // 授权通过：执行工具
        let result;
        try {
          onEvent({ type: "tool_call", id: call.id, name: call.function.name, arguments: args });
          result = tool ? await tool.run(args) : { error: "unknown tool" };
          onEvent({ type: "tool_result", id: call.id, name: call.function.name, result });
        } catch (e) { result = { error: String(e.message || e) }; onEvent({ type: "tool_result", id: call.id, name: call.function.name, result }); }
        if (persist && callIds[i] != null) {
          await store.run("call.update", { id: callIds[i], status: result && result.error ? "failed" : "succeeded", result });
        }
        conv.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        if (persist && callIds[i] != null) {
          await store.run("message.add", { step_id: step.id, seq: i + 1, role: "tool", content: JSON.stringify(result), tool_call_id: callIds[i] });
        }
      }
      if (persist) await store.run("step.update", { id: step.id, status: "succeeded" });
    }

    const last = conv[conv.length - 1];
    onEvent({ type: "done", message: last });
    if (persist) await store.run("turn.update", { id: turn.id, status: "failed" });
    return last;
  }

  // 拉取供应者远端模型列表（OpenAI 兼容 /models），用于辅助新增模型；走 Node 侧请求，绕开渲染层 CORS
  async fetchProviderModels(baseurl, apikey) {
    if (!baseurl) throw new Error("缺少 baseurl");
    let u;
    try { u = new URL(baseurl); } catch (e) { throw new Error("baseurl 不合法"); }
    const prefix = u.pathname.replace(/\/$/, "");
    const url = u.origin + prefix + "/models";
    const headers = { Accept: "application/json" };
    if (apikey) headers["Authorization"] = "Bearer " + apikey;
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch (_) {}
      throw new Error("HTTP " + res.status + (detail ? " " + detail : ""));
    }
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
    return list.map((m) => ({ id: m.id || m.name, owned_by: m.owned_by || "" })).filter((m) => m.id);
  }
}

// 统一的「函数分发」：各传输层只负责把通道里的请求转成这次调用
async function handleCall(core, { fn, params = {}, onEvent = () => {} } = {}) {
  switch (fn) {
    case "chat": return await core.chat(Object.assign({ onEvent }, params));
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
