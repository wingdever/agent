"use strict";
// Radeon (AMD developer) provider 适配器。
// 该 provider 暴露 OpenAI 兼容的 /models 接口，模型列表在 data[] 中。
// fetch() 自行发 GET /models 并落盘原始响应；adapt() 提取并映射为现有 providers.json schema。
//
// schema（与 user/providers.json 一致）：
//   provider: { name, base_url, api_key?, description?, models: [{ name, fee, effort?: { supported_levels, default_level } }] }

const PROVIDERS_FILE = require("path").join(__dirname, "..", "user", "providers.json");

function readExistingProvider(name) {
  try {
    const arr = JSON.parse(require("fs").readFileSync(PROVIDERS_FILE, "utf8"));
    if (!Array.isArray(arr)) return null;
    return arr.find((p) => p.name === name) || null;
  } catch (_) {
    return null;
  }
}

// 通用：GET {baseUrl}/models，返回落盘结构；失败也返回（error:true）。
async function fetchModels({ baseUrl, apiKey }) {
  const url = baseUrl.replace(/\/$/, "") + "/models";
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch (_) { /* 保留文本 */ }
    return { provider: "radeon", base_url: baseUrl, fetchedAt: new Date().toISOString(), status: res.status, body };
  } catch (e) {
    return { provider: "radeon", base_url: baseUrl, fetchedAt: new Date().toISOString(), status: 0, body: String(e.message || e), error: true };
  }
}

// 从 OpenAI 兼容响应提取模型数组；兼容 data[] 与 models[]。
function extractModelList(body) {
  if (!body || typeof body !== "object") return [];
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return list.filter((m) => m && (m.id || m.name));
}

// 按厂商差异适配单个模型为现有 schema。
function adaptModel(m) {
  const name = m.id || m.name;
  const out = { name, fee: "unknown", enabled: false };
  // 推理等级：优先取服务端返回（DeepSeek 风格 m.effort.supported_levels / Venice 风格 model_spec.capabilities.reasoningEffortOptions）；
  // radeon 的 /models 不返回推理元数据，故由模块声明 effortLevels 作为基线（见下方 module.exports）。
  const spec = m.model_spec || m.spec || {};
  const cap = spec.capabilities || {};
  let levels = null;
  if (m.effort && Array.isArray(m.effort.supported_levels)) levels = m.effort.supported_levels;
  else if (cap.reasoningEffortOptions && Array.isArray(cap.reasoningEffortOptions)) levels = cap.reasoningEffortOptions;
  if (!levels && module.exports.effortLevels && module.exports.effortLevels.length) levels = module.exports.effortLevels;
  if (levels && levels.length) {
    out.effort = { supported_levels: levels.slice() };
    if (m.effort && m.effort.default_level) out.effort.default_level = m.effort.default_level;
    else if (cap.defaultReasoningEffort) out.effort.default_level = cap.defaultReasoningEffort;
    else if (module.exports.effortDefault) out.effort.default_level = module.exports.effortDefault;
  }
  return out;
}

module.exports = {
  name: "radeon",
  baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
  apiKeyEnv: "RADEON_API_KEY",
  // radeon 不认 thinking 参数，仅支持 reasoning_effort；关闭推理用原生 "none" 档（实测 off 会 400）。
  reasoningParam: "reasoning_effort",
  // radeon 的 /models 不暴露推理等级，此处声明基线（用户可在 UI 覆盖）。
  // 实测 /chat/completions 报错返回的合法枚举：none/minimal/low/medium/high/xhigh/max。
  // 其中 none 为关闭推理档（已纳入枚举首位）；off 不是合法值（会 400），故不列入。
  effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  effortDefault: "medium",

  async fetch() {
    // base_url / api_key 优先用现有 providers.json 里的配置（用户已在 UI 填过）
    const existing = readExistingProvider("radeon");
    const baseUrl = (existing && existing.base_url) || this.baseUrl;
    const apiKey = (existing && existing.api_key) || process.env[this.apiKeyEnv] || "";
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    return fetchModels({ baseUrl, apiKey });
  },

  adapt(raw) {
    const list = extractModelList(raw && raw.body);
    return { models: list.map(adaptModel) };
  },
};
