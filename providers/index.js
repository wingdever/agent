"use strict";
// providers/ runner：按 provider 名（或全部）执行两步走：
//   1. fetch()  -> 拉取该 provider 的 /models 原始响应，落盘 user/providers/<name>.json
//   2. adapt()  -> 从落盘的原始响应提取并适配为现有 providers.json schema，合并写回 user/providers.json
// 独立于 core：自带最小 read/write providers 实现，不引入运行时模块。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PROVIDERS_DIR = __dirname;
const USER_DIR = path.join(ROOT, "user");
const PROVIDERS_FILE = path.join(USER_DIR, "providers.json");
const RAW_DIR = path.join(USER_DIR, "providers");

// ---- 最小 providers.json 读写（schema 与 core/index.js:45-68 保持一致）----
function readProvidersFile() {
  try {
    const arr = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    if (!Array.isArray(arr)) return [];
    return arr.map((p) => ({
      name: p.name,
      base_url: p.base_url || null,
      api_key: p.api_key || null,
      description: p.description || null,
      reasoning_param: p.reasoning_param || null,
      models: Array.isArray(p.models) ? p.models : [],
    }));
  } catch (_) {
    return [];
  }
}
function writeProvidersFile(arr) {
  fs.mkdirSync(path.dirname(PROVIDERS_FILE), { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(arr || [], null, 2));
  return arr || [];
}

function loadProviderModules() {
  const files = fs.readdirSync(PROVIDERS_DIR).filter((f) => /\.js$/.test(f) && f !== "index.js");
  const mods = [];
  for (const f of files) {
    const mod = require(path.join(PROVIDERS_DIR, f));
    if (mod && mod.name && typeof mod.fetch === "function" && typeof mod.adapt === "function") {
      mods.push(mod);
    } else {
      console.warn(`[providers] 跳过 ${f}：缺少 name/fetch/adapt 导出`);
    }
  }
  return mods;
}

function rawPathFor(name) {
  return path.join(RAW_DIR, name + ".json");
}

// 合并模型：以远端适配结果（incoming）为准，但保留既有 providers.json 中用户手改的 effort/fee/enabled。
// 这样重跑 providers 不会清掉用户在 UI 维护的推理等级 / 费用 / 启用状态。按 name 匹配。
function mergeModels(existingModels, incoming) {
  const byName = {};
  (existingModels || []).forEach((m) => { if (m && m.name) byName[m.name] = m; });
  return (incoming || []).map((m) => {
    const ex = byName[m.name];
    if (!ex) return m;
    const out = Object.assign({}, m);
    if (ex.effort && !out.effort) out.effort = ex.effort;
    if (ex.fee && ex.fee !== "unknown" && (!out.fee || out.fee === "unknown")) out.fee = ex.fee;
    // 保留已启用的状态（incoming 默认 enabled:false，避免把用户启用的模型重置）
    if (ex.enabled) out.enabled = true;
    return out;
  });
}

async function runOne(mod) {
  console.log(`\n=== provider: ${mod.name} ===`);
  // 1) fetch 落盘
  let raw;
  try {
    raw = await mod.fetch();
  } catch (e) {
    raw = { provider: mod.name, base_url: mod.baseUrl || null, fetchedAt: new Date().toISOString(), status: 0, body: String(e.message || e), error: true };
  }
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(rawPathFor(mod.name), JSON.stringify(raw, null, 2));
  console.log(`[fetch] status=${raw.status} -> ${path.relative(ROOT, rawPathFor(mod.name))}`);
  if (raw.error || (raw.status && raw.status >= 400)) {
    console.warn(`[fetch] 拉取失败（status=${raw.status}），仍已落盘原始响应；跳过 adapt 与写回，保留现有配置。`);
    return;
  }

  // 2) adapt 并合并写回 providers.json
  const adapted = mod.adapt(raw) || {};
  const incoming = Array.isArray(adapted.models) ? adapted.models : [];
  // 适配出 0 个模型（如接口临时异常）时，不覆盖现有 models，避免清空配置。
  if (incoming.length === 0) {
    console.warn(`[adapt] 适配出 0 个模型，跳过写回，保留现有配置。`);
    return;
  }
  console.log(`[adapt] 适配出 ${incoming.length} 个模型`);

  const providers = readProvidersFile();
  let p = providers.find((x) => x.name === mod.name);
  if (!p) {
    p = { name: mod.name, base_url: mod.baseUrl || null, api_key: null, description: null, models: [] };
    providers.push(p);
    console.log(`[merge] 新增 provider ${mod.name}`);
  }
  // 仅整体替换 models；保留既有 base_url/api_key/description/reasoning_param（除非原本缺）
  if (p.base_url == null && mod.baseUrl) p.base_url = mod.baseUrl;
  if (p.api_key == null && mod.apiKey) p.api_key = mod.apiKey;
  if (p.description == null && adapted.description) p.description = adapted.description;
  if (p.reasoning_param == null && (mod.reasoningParam || adapted.reasoning_param)) p.reasoning_param = mod.reasoningParam || adapted.reasoning_param;
  // 合并而非整体替换：保留用户手改的 effort/fee
  p.models = mergeModels(p.models, incoming);
  writeProvidersFile(providers);
  console.log(`[merge] 写回 user/providers.json（${mod.name} 现有 ${p.models.length} 个模型）`);
}

async function main() {
  const arg = process.argv[2];
  const mods = loadProviderModules();
  const targets = arg ? mods.filter((m) => m.name === arg) : mods;
  if (arg && targets.length === 0) {
    console.error(`[providers] 未找到 provider "${arg}"。可用：${mods.map((m) => m.name).join(", ") || "（无）"}`);
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error("[providers] providers/ 下没有可用模块。");
    process.exit(1);
  }
  for (const mod of targets) {
    try {
      await runOne(mod);
    } catch (e) {
      console.error(`[providers] ${mod.name} 处理异常：${e.message || e}`);
    }
  }
  console.log("\n[providers] 完成。");
}

main().catch((e) => {
  console.error("[providers] 运行失败:", e.message || e);
  process.exit(1);
});
