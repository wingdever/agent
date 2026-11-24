"use strict";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __pathDirname } from "node:path";
import path from "path";
import fs from "fs";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));

// 讯飞云 MaaS (xf-yun) provider 适配器。
// OpenAI 兼容接口，base_url 含 /v2 路径段；/models 返回标准 data[]；
// 模型会读取 reasoning_effort（实测响应 reasoning_content 中回显 thinking_effort high），故 reasoning_param 用 reasoning_effort。
//
// schema（与 user/providers.json 一致）：
//   provider: { name, base_url, api_key?, description?, reasoning_param, models: [{ name, fee, effort?: {...} }] }

const PROVIDERS_FILE = path.join(__dirname, "..", "user", "providers.json");

function readExistingProvider(name) {
  try {
    const arr = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    if (!Array.isArray(arr)) return null;
    return arr.find((p) => p.name === name) || null;
  } catch (_) {
    return null;
  }
}

async function fetchModels({ baseUrl, apiKey }) {
  const url = baseUrl.replace(/\/$/, "") + "/models";
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  try {
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch (_) { /* 保留文本 */ }
    return { provider: "xf-yun", base_url: baseUrl, fetchedAt: new Date().toISOString(), status: res.status, body };
  } catch (e) {
    return { provider: "xf-yun", base_url: baseUrl, fetchedAt: new Date().toISOString(), status: 0, body: String(e.message || e), error: true };
  }
}

function extractModelList(body) {
  if (!body || typeof body !== "object") return [];
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return list.filter((m) => m && (m.id || m.name));
}

function adaptModel(m) {
  const name = m.id || m.name;
  const out = { name, fee: "unknown", enabled: false };
  const spec = m.model_spec || m.spec || {};
  const cap = spec.capabilities || {};
  let levels = null;
  if (m.effort && Array.isArray(m.effort.supported_levels)) levels = m.effort.supported_levels;
  else if (cap.reasoningEffortOptions && Array.isArray(cap.reasoningEffortOptions)) levels = cap.reasoningEffortOptions;
  if (!levels && __provider.effortLevels && __provider.effortLevels.length) levels = __provider.effortLevels;
  if (levels && levels.length) {
    out.effort = { supported_levels: levels.slice() };
    if (m.effort && m.effort.default_level) out.effort.default_level = m.effort.default_level;
    else if (cap.defaultReasoningEffort) out.effort.default_level = cap.defaultReasoningEffort;
    else if (__provider.effortDefault) out.effort.default_level = __provider.effortDefault;
  }
  return out;
}

const __provider = {
  name: "xf-yun",
  baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
  apiKeyEnv: "XF_YUN_API_KEY",
  // xf-yun 读取 reasoning_effort（实测响应回显 thinking_effort high），不认 thinking 参数。
  reasoningParam: "reasoning_effort",
  // /models 通常不暴露推理等级，声明基线；xf-yun 接受 OpenAI 风格 low/medium/high。
  effortLevels: ["none", "low", "medium", "high"],
  effortDefault: "medium",

  async fetch() {
    const existing = readExistingProvider("xf-yun");
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

export default __provider;
