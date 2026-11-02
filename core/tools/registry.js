"use strict";

// Tool registry: scans tools/<name>/registry.json, loads the entry module, and
// normalizes the model-facing fields plus runtime options.

const fs = require("fs");
const path = require("path");

const TOOLS_DIR = path.join(__dirname, "..", "..", "tools");
const EMPTY_SCHEMA = { type: "object", properties: {}, required: [] };

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

    const entryFile = reg.entry || "run.js";
    const resolved = path.resolve(dir, entryFile);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      console.error("[tools] entry escapes tool directory:", reg.name, entryFile);
      continue;
    }
    let mod;
    try {
      mod = require(resolved);
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
      type: typeof reg.type === "string" ? reg.type : entry.name,
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

module.exports = { TOOLS_DIR, loadTools };
