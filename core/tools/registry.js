"use strict";

// Tool registry: scans tools/<name>/registry.json, loads the entry module, and
// normalizes the model-facing fields plus runtime options.

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
  "fs", "shell", "web", "browser", "job", "agent", "team", "schedule",
  "goal", "interaction", "channel", "skill", "mcp", "utility",
]);

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function loadTools() {
  const map = new Map();
  let dirs;
  try {
    dirs = await fs.promises.readdir(TOOLS_DIR, { withFileTypes: true });
  } catch (_) {
    return map;
  }

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(TOOLS_DIR, entry.name);
    let reg;
    try {
      reg = JSON.parse(await fs.promises.readFile(path.join(dir, "registry.json"), "utf8"));
    } catch (_) {
      continue; // directories without a registry (tools/lib) are not tools
    }
    if (!reg || typeof reg !== "object" || typeof reg.name !== "string" || !reg.name.trim()) {
      console.error("[tools] skip registry without a valid name:", entry.name);
      continue;
    }

    if (!MODES.has(reg.mode)) {
      console.error("[tools] registry without a valid mode (read/write/both):", reg.name);
    }
    if (!GROUPS.has(reg.group)) {
      console.error("[tools] registry without a valid group:", reg.name);
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

    map.set(reg.name, {
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
      run,
    });
  }
  return map;
}

const __exports = { TOOLS_DIR, loadTools };
export { TOOLS_DIR, loadTools };
export default __exports;
