"use strict";

// 节点间共享的轻量工具（node-graph 引擎内部使用，不对外导出）。
// 复刻 linear.js 里与 index.js 解耦的本地实现，避免循环依赖。

const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "..", "..", "user", "settings.json");
const PROVIDERS_FILE = path.join(__dirname, "..", "..", "user", "providers.json");

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (_) { return {}; }
}

// 读取 user/providers.json 解析某供应者的 baseUrl/apiKey/默认模型（取首个模型）。
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

module.exports = { SETTINGS_FILE, PROVIDERS_FILE, readSettings, resolveProvider };
