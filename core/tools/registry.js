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
// Per-package configuration written by the user (toolpack.md §2). Read at load
// time; changing it takes effect on the next start.
const TOOLPACKS_FILE = path.join(__dirname, "..", "..", "user", "toolpacks.json");
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

// Read user/toolpacks.json. Shape: { "<package>": { "promptVars": { … } } }.
// A missing or malformed file is not fatal: every package then runs on its
// registry defaults.
function readToolpacks() {
  try {
    const data = JSON.parse(fs.readFileSync(TOOLPACKS_FILE, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizePromptVars(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// Synthesize the package objects from the selected tools plus the user's
// toolpacks.json (toolpack.md §1-§3):
//   - a tool's package is its declared `package`, else its `group`;
//   - the package leader is its alphabetically first member, the same rule the
//     shared prompt section uses for its text;
//   - package fields (promptSection, promptVarDefaults) come from the leader;
//   - promptVars = leader defaults overridden by the user's entry.
function buildToolpacks(tools, userPacks) {
  const groups = new Map();
  for (const tool of tools) {
    const name = tool.packageName;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(tool);
  }
  const packs = new Map();
  const warnings = [];
  for (const [name, members] of groups) {
    members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const leader = members[0];
    for (const member of members.slice(1)) {
      if (member.promptVarDefaults) {
        warnings.push("[tools] " + member.name + ": promptVarDefaults is declared on package leader \"" +
          leader.name + "\" only; ignored");
      }
    }
    const defaults = leader.promptVarDefaults || {};
    const userEntry = userPacks[name] && typeof userPacks[name] === "object" ? userPacks[name] : null;
    const userVars = userEntry ? normalizePromptVars(userEntry.promptVars) : undefined;
    packs.set(name, {
      name,
      leader: leader.name,
      members: members.map((member) => member.name),
      promptSection: leader.promptSection || name,
      defaultVisible: members.every((member) => member.defaultVisible !== false),
      promptVars: { ...defaults, ...(userVars || {}) },
    });
  }
  // Unknown package names in the user file are configuration mistakes worth a
  // warning, but they must not stop the tool table from loading.
  for (const name of Object.keys(userPacks)) {
    if (!packs.has(name)) warnings.push("[tools] toolpacks.json names unknown package \"" + name + "\"; ignored");
  }
  for (const warning of warnings) console.warn(warning);
  for (const tool of tools) {
    const pack = packs.get(tool.packageName);
    tool.package = pack || null;
  }
  return packs;
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
      // Package identity: explicit `package`, else the UI group. The package
      // object is attached after provider selection (buildToolpacks).
      packageName: typeof reg.package === "string" && reg.package.trim()
        ? reg.package.trim()
        : (GROUPS.has(reg.group) ? reg.group : "utility"),
      // Package-level fields, valid only on the package leader.
      promptVarDefaults: normalizePromptVars(reg.promptVarDefaults),
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
  buildToolpacks([...map.values()], options.toolpacks || readToolpacks());
  return map;
}

const __exports = { TOOLS_DIR, TOOLPACKS_FILE, loadTools, readToolpacks, buildToolpacks };
export { TOOLS_DIR, TOOLPACKS_FILE, loadTools, readToolpacks, buildToolpacks };
export default __exports;
