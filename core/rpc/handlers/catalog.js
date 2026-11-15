"use strict";

const fs = require("fs");
const { isUserInvocable, isModelInvocable, isSkillName } = require("../../skills");
const { loadNodes } = require("../../loops/registry");
const { listEngineNames, DEFAULT_ENGINE } = require("../../loops");
const loopsConfig = require("../../loops/loops-config");

const noParams = { type: "object", properties: {}, additionalProperties: false };

function loopsSnapshot(core) {
  const nodesMap = loadNodes();
  const nodes = [];
  const builtins = [];
  for (const node of nodesMap.values()) {
    nodes.push({ id: node.id, type: node.type, next: node.next, hooks: node.hooks });
    if (node.type === "builtin") builtins.push(node.id);
  }
  const coreNodeIds = nodes.filter((n) => n.type !== "builtin").map((n) => n.id);
  const allNodeIds = nodes.map((n) => n.id);
  const settings = core.config.readSettings();
  return {
    engines: listEngineNames(),
    currentEngine: process.env.AGENT_LOOP_ENGINE || DEFAULT_ENGINE,
    defaultEngine: DEFAULT_ENGINE,
    nodes,
    builtins,
    hooks: loopsConfig.readLoops(),
    translateEnabledInLinear: !!(settings.translate && settings.translate.enabled),
    coreNodeIds,
    allNodeIds,
  };
}

function skillEntry(skill) {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse != null ? skill.whenToUse : null,
    provider: skill.provider != null ? skill.provider : "unknown",
    source: skill.source != null ? skill.source : (skill.provider != null ? skill.provider : "unknown"),
    modelInvocable: isModelInvocable(skill),
  };
}

module.exports = function defineCatalogCommands(rpc) {
  rpc.define({
    name: "models.fetch",
    params: {
      type: "object",
      properties: { baseurl: { type: "string" }, apikey: { type: "string" } },
      required: ["baseurl"],
      additionalProperties: false,
    },
    handler: (core, params) => core.model.fetchModels(params.baseurl, params.apikey),
  });

  rpc.define({
    name: "models.capabilities",
    params: {
      type: "object",
      properties: { provider: { type: "string" }, model: { type: "string" } },
      required: ["model"],
      additionalProperties: false,
    },
    handler: (core, params) => core.model.capabilities(params),
  });

  rpc.define({
    name: "models.contextWindow",
    params: {
      type: "object",
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        settings: { type: "object" },
      },
      additionalProperties: false,
    },
    handler: (core, params) => ({
      model: params.model || null,
      contextWindow: core.config.resolveContextWindow(params),
    }),
  });

  rpc.define({
    name: "skills.list",
    params: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (core, params) => {
      const cwd = params.cwd || process.cwd();
      if (!core.skills) return [];
      const skills = await core.skills.list({ cwd });
      return skills.filter((s) => isUserInvocable(s)).map(skillEntry);
    },
  });

  rpc.define({
    name: "skills.get",
    params: {
      type: "object",
      properties: { name: { type: "string" }, cwd: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (core, params) => {
      const cwd = params.cwd || process.cwd();
      if (!isSkillName(params.name)) throw new Error(`invalid skill name "${params.name}"`);
      const skill = core.skills ? await core.skills.get(params.name, { cwd }) : null;
      if (!skill || !isUserInvocable(skill)) throw new Error(`skill "${params.name}" is not available`);
      return Object.assign(skillEntry(skill), {
        content: skill.content != null ? skill.content : "",
        resourceBase: skill.resourceBase || null,
      });
    },
  });

  rpc.define({
    name: "tools.list",
    params: noParams,
    handler: (core) => core.tools.listFunctions(),
  });

  const loopsView = (core) => {
    const snapshot = loopsSnapshot(core);
    const { coreNodeIds, allNodeIds, ...view } = snapshot;
    return view;
  };

  rpc.define({
    name: "loops.get",
    params: noParams,
    handler: (core) => loopsView(core),
  });

  rpc.define({
    name: "loops.list",
    params: noParams,
    handler: (core) => loopsView(core),
  });

  rpc.define({
    name: "loops.upsert",
    params: {
      type: "object",
      properties: { payload: { type: "object" } },
      required: ["payload"],
      additionalProperties: false,
    },
    handler: (core, params) => {
      const snapshot = loopsSnapshot(core);
      const hooks = (params.payload && params.payload.hooks) || [];
      loopsConfig.validateHooks(hooks, snapshot.coreNodeIds, snapshot.allNodeIds);
      loopsConfig.writeLoops(hooks);
      return { ok: true, hooks };
    },
  });

  rpc.define({
    name: "fs.read",
    params: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (core, params) => {
      const p = String(params.path || "");
      if (!p) throw new Error("fs.read requires path");
      const MAX = 200000;
      try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) return { path: p, isDirectory: true, content: "" };
        const size = stat.size;
        const content = fs.readFileSync(p, "utf8");
        return {
          path: p,
          isDirectory: false,
          truncated: size > MAX,
          content: content.length > MAX ? content.slice(0, MAX) : content,
        };
      } catch (e) {
        throw new Error("fs.read failed: " + (e.message || e));
      }
    },
  });
};
