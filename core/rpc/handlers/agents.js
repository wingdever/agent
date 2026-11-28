"use strict";

// Agent profile commands. Profiles are configuration, not runtime instances.
// The main profile lives in agent/config.json (no id, used as the default);
// optional profiles live in agents/<id>/config.json, where the directory name
// is the id. Both directories are git-ignored local configuration.

import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./../../../lib/paths/index.js";
import { mainProfile } from "./../../../lib/agent-profile/index.js";
import { loadNodes } from "./../../loops/registry.js";
import loopsConfig from "./../../loops/loops-config.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const EFFORTS = new Set(["low", "medium", "high"]);
const FIELDS = ["name", "identity", "persona", "provider", "model", "effort", "tools"];
const BOT_FILES = ["prompt", "tools.json", "loops.json"];

const byId = {
  type: "object",
  properties: { id: { type: "string" } },
  additionalProperties: false,
};
const payloadObject = {
  type: "object",
  properties: {
    payload: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        identity: { type: "string" },
        persona: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
        prompt: { type: "string" },
        loops: { type: "array" },
      },
      additionalProperties: false,
    },
  },
  required: ["payload"],
  additionalProperties: false,
};
const noParams = { type: "object", properties: {}, additionalProperties: false };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function readConfig(file) {
  const parsed = readJson(file, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function profileFile(dir, id) {
  return path.join(dir, id, "config.json");
}

function validate(id, config) {
  const issues = [];
  if (id && !ID_PATTERN.test(id)) issues.push("id must be lower-case letters, digits and hyphens, starting with a letter");
  if (id && (!config.name || typeof config.name !== "string")) issues.push("name is required for an optional agent");
  if (config.name != null && typeof config.name !== "string") issues.push("name must be a string");
  if (config.identity != null && typeof config.identity !== "string") issues.push("identity must be a string");
  if (config.persona != null && typeof config.persona !== "string") issues.push("persona must be a string");
  if (config.provider != null && typeof config.provider !== "string") issues.push("provider must be a string");
  if (config.model != null && typeof config.model !== "string") issues.push("model must be a string");
  if (config.effort != null && config.effort !== "" && !EFFORTS.has(config.effort)) issues.push("effort must be low, medium or high");
  if (config.tools != null && (!Array.isArray(config.tools) || config.tools.some((name) => typeof name !== "string"))) {
    issues.push("tools must be an array of tool names");
  }
  return issues;
}

function pick(config) {
  const out = {};
  FIELDS.forEach((field) => { if (config[field] !== undefined) out[field] = config[field]; });
  return out;
}

// Bot profiles keep prompt/tools/loops in their own files; tools.json, not
// config.tools, is the allowlist the runtime reads for agents/<id>/.
function readBotFiles(botDir) {
  const tools = readJson(path.join(botDir, "tools.json"), []);
  const loops = readJson(path.join(botDir, "loops.json"), []);
  let prompt = "";
  try { prompt = fs.readFileSync(path.join(botDir, "prompt"), "utf8").trim(); } catch (_) { /* optional */ }
  return {
    tools: Array.isArray(tools) ? tools : [],
    loops: Array.isArray(loops) ? loops : [],
    prompt,
  };
}

function readBotDetail(dir, id) {
  return Object.assign(
    { id },
    pick(readConfig(profileFile(dir, id))),
    readBotFiles(path.join(dir, id))
  );
}

function validateBotFiles(payload) {
  const issues = [];
  if (payload.prompt != null && typeof payload.prompt !== "string") issues.push("prompt must be a string");
  const tools = payload.tools != null ? payload.tools : [];
  if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string")) {
    issues.push("tools must be an array of tool names");
  }
  const loops = payload.loops != null ? payload.loops : [];
  if (!Array.isArray(loops)) {
    issues.push("loops must be an array of hooks");
  } else {
    const nodes = [...loadNodes().values()];
    const coreNodeIds = nodes.filter((node) => node.type !== "builtin").map((node) => node.id);
    const allNodeIds = nodes.map((node) => node.id);
    loopsConfig.validateHooks(loops, coreNodeIds, allNodeIds);
  }
  if (issues.length) throw new Error("invalid agent: " + issues.join("; "));
  return { prompt: typeof payload.prompt === "string" ? payload.prompt : "", tools, loops };
}

export default function defineAgentCommands(
  rpc,
  {
    mainFile = path.join(PROJECT_ROOT, "agent", "config.json"),
    assetsFile = path.join(PROJECT_ROOT, "assets", "agent", "config.json"),
    agentsDir = path.join(PROJECT_ROOT, "agents"),
    channelsFile = path.join(PROJECT_ROOT, "user", "channels.json"),
  } = {}
) {
  function main() {
    return pick(mainProfile({ mainFile, assetsFile }));
  }

  function others() {
    let names = [];
    try {
      names = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => ID_PATTERN.test(name) && fs.existsSync(profileFile(agentsDir, name)));
    } catch (_) {
      return [];
    }
    return names.map((id) => readBotDetail(agentsDir, id));
  }

  function boundChannels(id) {
    try {
      const parsed = JSON.parse(fs.readFileSync(channelsFile, "utf8"));
      return (parsed.channels || [])
        .filter((channel) => channel && channel.agent === id)
        .map((channel) => channel.id);
    } catch (_) {
      return [];
    }
  }

  rpc.define({
    name: "agent.list",
    params: noParams,
    handler: () => ({ main: main(), agents: others() }),
  });

  rpc.define({
    name: "agent.get",
    params: byId,
    handler: (core, value) => {
      const id = value.id || "";
      if (!id) return main();
      if (!ID_PATTERN.test(id)) throw new Error(`invalid agent id "${id}"`);
      const file = profileFile(agentsDir, id);
      return fs.existsSync(file) ? readBotDetail(agentsDir, id) : null;
    },
  });

  rpc.define({
    name: "agent.upsert",
    params: payloadObject,
    handler: (core, value) => {
      const payload = value.payload || {};
      const id = payload.id || "";
      const config = pick(payload);
      const issues = validate(id, payload);
      if (issues.length) throw new Error("invalid agent: " + issues.join("; "));
      if (!id) {
        fs.mkdirSync(path.dirname(mainFile), { recursive: true });
        fs.writeFileSync(mainFile, JSON.stringify(config, null, 2));
        return config;
      }
      if (!ID_PATTERN.test(id)) throw new Error(`invalid agent id "${id}"`);
      // Validate everything before any write: a bad hook must not leave a half-updated profile.
      const botFiles = validateBotFiles(payload);
      const botConfig = Object.assign({}, config);
      delete botConfig.tools; // tools.json is authoritative for bot agents
      const dir = path.join(agentsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(profileFile(agentsDir, id), JSON.stringify(botConfig, null, 2));
      fs.writeFileSync(path.join(dir, "prompt"), botFiles.prompt);
      fs.writeFileSync(path.join(dir, "tools.json"), JSON.stringify(botFiles.tools, null, 2));
      fs.writeFileSync(path.join(dir, "loops.json"), JSON.stringify(botFiles.loops, null, 2));
      return Object.assign({ id }, botConfig, botFiles);
    },
  });

  rpc.define({
    name: "agent.delete",
    params: byId,
    handler: (core, value) => {
      const id = value.id || "";
      if (!id) throw new Error("the main agent cannot be deleted");
      if (!ID_PATTERN.test(id)) throw new Error(`invalid agent id "${id}"`);
      const usedBy = boundChannels(id);
      if (usedBy.length) throw new Error(`cannot delete agent "${id}": bound to channel ${usedBy.join(", ")}`);
      const file = profileFile(agentsDir, id);
      if (!fs.existsSync(file)) throw new Error(`unknown agent "${id}"`);
      const dir = path.join(agentsDir, id);
      fs.unlinkSync(file);
      for (const name of BOT_FILES) {
        const extra = path.join(dir, name);
        if (fs.existsSync(extra)) fs.unlinkSync(extra);
      }
      try { fs.rmdirSync(dir); } catch (_) { /* keep a directory holding other files */ }
      return { deleted: true };
    },
  });
}
