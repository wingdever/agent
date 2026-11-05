"use strict";
// DeepSeek provider 适配器。
// DeepSeek 暴露 OpenAI 兼容的 /models 接口（data[]），其中仅含 id/object/owned_by 等基础字段，
// 推理等级（supported_levels/default_level）不在 /models 响应里，故 adapt 只映射 name + fee，
// effort 仍由 UI「编辑模型」按厂商文档手动维护（或后续从其它端点补充）。
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

async function fetchModels({ baseUrl, apiKey }) {
  const url = baseUrl.replace(/\/$/, "") + "/models";
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  try {
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch (_) { /* 保留文本 */ }
    return { provider: "deepseek", base_url: baseUrl, fetchedAt: new Date().toISOString(), status: res.status, body };
  } catch (e) {
    return { provider: "deepseek", base_url: baseUrl, fetchedAt: new Date().toISOString(), status: 0, body: String(e.message || e), error: true };
  }
}

function extractModelList(body) {
  if (!body || typeof body !== "object") return [];
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return list.filter((m) => m && (m.id || m.name));
}

function adaptModel(m) {
  const name = m.id || m.name;
  // DeepSeek 官方模型默认付费；这里统一标 "paid"，可由 UI 覆盖。
  const out = { name, fee: "paid", enabled: false };
  // DeepSeek 的 /models 不暴露推理等级，由模块声明基线（见下方 module.exports.effortLevels）。
  const levels = module.exports.effortLevels;
  if (levels && levels.length) {
    out.effort = { supported_levels: levels.slice() };
    if (module.exports.effortDefault) out.effort.default_level = module.exports.effortDefault;
  }
  return out;
}

module.exports = {
  name: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  // DeepSeek 支持 thinking 参数（none 关推理时发 thinking.disabled），其余等级发 reasoning_effort。
  // 关闭推理档用 "none"（与 radeon/OpenAI 一致），不用 off。
  reasoningParam: "thinking",
  // DeepSeek 的 /models 不暴露推理等级，此处声明基线：实测可用 none/low/high/max。
  effortLevels: ["none", "low", "high", "max"],
  effortDefault: "high",

  async fetch() {
    const existing = readExistingProvider("deepseek");
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
