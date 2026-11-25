"use strict";

// Tool registry: scans tools/<name>/registry.json, loads the entry module, and
// normalizes the model-facing fields plus runtime options.
//
// A tool name is a slot. More than one package may provide the same slot
// (notably `bash` one-shot vs persistent); exactly one provider is registered.
// Choice order: explicit AGENT_TOOL_PROVIDER_<NAME>, then defaultProvider, then
// the highest registry priority. Never register two tools with the same name.

import fs from "fs";
import path from "path";
import { fileURLToPath as __fileURLToPath, pathToFileURL } from "node:url";
import { dirname as __pathDirname } from "node:path";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));


const TOOLS_DIR = path.join(__dirname, "..", "..", "tools");
const EMPTY_SCHEMA = { type: "object", properties: {}, required: [] };

// mode 描述写特性（权限判定用），group 描述能力分组（UI 分类用），两者互不依赖。
const MODES = new Set(["read", "write", "both"]);
const GROUPS = new Set([
  "fs", "shell", "terminal", "code", "web", "browser", "job", "agent", "team", "schedule",
  "goal", "interaction", "deliverable", "channel", "skill", "mcp", "utility",
]);

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function providerEnvKey(name) {
  return "AGENT_TOOL_PROVIDER_" + String(name).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function chooseProvider(name, candidates, options) {
  if (candidates.length === 1) return candidates[0];

  const providers = options.providers || {};
  const env = options.env || process.env;
  const explicit = providers[name] || env[providerEnvKey(name)];
  if (explicit) {
    const wanted = String(explicit);
    const match = candidates.find((candidate) =>
      candidate.provider === wanted || candidate.dirName === wanted);
    if (match) return match;
    console.error("[tools] unknown provider \"" + wanted + "\" for tool \"" + name +
      "\"; candidates: " + candidates.map((candidate) => candidate.provider).join(", "));
  }

  const defaultProvider = candidates.filter((candidate) => candidate.reg.defaultProvider === true);
  if (defaultProvider.length === 1) return defaultProvider[0];

  const maxPriority = Math.max(...candidates.map((candidate) => candidate.priority));
  const preferred = candidates.filter((candidate) => candidate.priority === maxPriority);
  if (preferred.length === 1) return preferred[0];

  console.error("[tools] ambiguous providers for tool \"" + name +
    "\": " + candidates.map((candidate) => candidate.dirName + "(" + candidate.provider + ")").join(", ") +
    "; set " + providerEnvKey(name) + " to choose one");
  return preferred[0];
}

async function loadTools(options = {}) {
  const candidates = new Map(); // name -> candidate[]
  let dirs;
  try {
    dirs = await fs.promises.readdir(TOOLS_DIR, { withFileTypes: true });
  } catch (_) {
    return new Map();
  }

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const dir = path.join(TOOLS_DIR, dirName);
    let reg;
    try {
      reg = JSON.parse(await fs.promises.readFile(path.join(dir, "registry.json"), "utf8"));
    } catch (_) {
      continue; // directories without a registry (tools/lib) are not tools
    }
    if (!reg || typeof reg !== "object" || typeof reg.name !== "string" || !reg.name.trim()) {
      console.error("[tools] skip registry without a valid name:", dirName);
      continue;
    }

    if (!MODES.has(reg.mode)) {
      console.error("[tools] registry without a valid mode (read/write/both):", reg.name);
    }
    if (!GROUPS.has(reg.group)) {
      console.error("[tools] registry without a valid group:", reg.group);
    }

    const entryFile = reg.entry || "run.js";
    const resolved = path.resolve(dir, entryFile);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      console.error("[tools] entry escapes tool directory:", reg.name, entryFile);
      continue;
    }
    let mod;
    try {
      // 工具入口是 ESM，只能动态 import；命名空间里可能同时有具名 run 与 default
      mod = await import(pathToFileURL(resolved).href);
    } catch (e) {
      console.error("[tools] load failed:", reg.name, e.message);
      continue;
    }
    const run = mod && (mod.run || (mod.default && mod.default.run));
    if (typeof run !== "function") {
      console.error("[tools] missing run():", reg.name);
      continue;
    }

    const provider = typeof reg.provider === "string" && reg.provider.trim()
      ? reg.provider.trim()
      : dirName;
    const priority = typeof reg.priority === "number" && Number.isFinite(reg.priority)
      ? reg.priority
      : 0;
    const tool = {
      name: reg.name,
      description: typeof reg.description === "string" ? reg.description : "",
      parameters: reg.parameters && typeof reg.parameters === "object" ? reg.parameters : EMPTY_SCHEMA,
      mode: MODES.has(reg.mode) ? reg.mode : "write",   // 缺省按最保守处理
      group: GROUPS.has(reg.group) ? reg.group : "utility",
      prompt: typeof reg.prompt === "string" ? reg.prompt : "",
      promptSection: typeof reg.promptSection === "string" && reg.promptSection.trim()
        ? reg.promptSection.trim()
        : "",
      timeoutMs: positiveNumber(reg.timeoutMs),
      concurrencySafe: reg.concurrencySafe === true,
      defaultVisible: reg.defaultVisible !== false,
      result: reg.result === "json" ? "json" : "text",
      provider,
      run,
    };
    const list = candidates.get(reg.name) || [];
    list.push({ ...tool, reg, dirName, provider, priority });
    candidates.set(reg.name, list);
  }

  const map = new Map();
  for (const [name, list] of candidates) {
    const selected = chooseProvider(name, list, options);
    // Keep only the normalized tool fields on the runtime object.
    const { reg, dirName, priority, ...tool } = selected;
    map.set(name, tool);
  }
  return map;
}

const __exports = { TOOLS_DIR, loadTools };
export { TOOLS_DIR, loadTools };
export default __exports;
