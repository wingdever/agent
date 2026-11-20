"use strict";

// Composition root. Services are created here and returned on a flat `core`
// object; there is intentionally no core.chat / core.approve facade.

const path = require("path");
const config = require("./config");
const { ModelService } = require("./model");
const { ContextService } = require("./context");
const { InteractionService } = require("./interactions");
const { ToolService } = require("./tools");
const { AgentRuntime } = require("./agent");
const { SubagentRuntime } = require("./subagent-runtime");
const { createWorkflowService } = require("./workflow");
const { createFlowService } = require("./flow");
const { runTool } = require("./tools/executor");
const { createRpc } = require("./rpc");
const { loadTools } = require("./tools/registry");
const { createGoalService } = require("./goals");
const {
  SkillRegistry,
  FileSystemSkillProvider,
  setSkillsRegistry,
} = require("./skills");
const { resolveWorkspaceFolder } = require("./context/workspace");

async function createCore(overrides = {}) {
  // Fail fast before opening the store: no enabled provider/model means the
  // app cannot answer anything, so a clear startup error is better than a
  // silent hardcoded fallback.
  config.resolveTarget({
    provider: overrides.provider,
    model: overrides.model,
    baseUrl: overrides.baseUrl,
    apiKey: overrides.apiKey,
  });

  const { createStore } = await import("./storage/store.mjs");
  const store = await createStore();
  const tools = new ToolService(await loadTools());
  const goals = createGoalService(store);
  const interactions = new InteractionService({ store });
  const model = new ModelService({ config });
  const skills = createSkillsRegistry();

  const context = new ContextService({ config, model, tools, skills, store });
  const agent = new AgentRuntime({ config, model, context, tools, skills, interactions, store, goals });

  const core = {
    config,
    model,
    context,
    tools,
    skills,
    interactions,
    agent,
    subagents: null,
    workflow: null,
    flow: null,
    store,
    goals,
    rpc: null,
  };
  agent.setCore(core);
  agent.setSubagents(() => core.subagents);
  context.setRuntime(agent);
  core.subagents = new SubagentRuntime(core);
  // Workflow runs read limits from user/settings.json's `workflow` block lazily,
  // so a settings edit applies to the next run without a restart.
  core.workflow = createWorkflowService({ config, getSubagents: () => core.subagents });
  // Flows are user-edited graphs run by the local backend; they never touch an
  // Agent instance (docs/flow/flow.md).
  core.flow = createFlowService({ store, model, config, tools, runTool });
  interactions.setRegistry(agent.registry);
  core.rpc = createRpc(core);
  return core;
}

function createSkillsRegistry() {
  const skillCfg = config.readSettings().skills || {};
  const registry = new SkillRegistry({
    logger: console,
    collectCacheMaxEntries: Number.isInteger(skillCfg.collectCacheMaxEntries)
      ? skillCfg.collectCacheMaxEntries
      : 128,
  });
  registry.registerProvider((control) =>
    new FileSystemSkillProvider(
      {
        includeDefaultRoots: true,
        bundledSkillDir: skillCfg.bundledSkillDir
          ? path.resolve(skillCfg.bundledSkillDir)
          : path.resolve(__dirname, "..", "skills"),
        customSkillDirs: Array.isArray(skillCfg.customSkillDirs) ? skillCfg.customSkillDirs : [],
        watch: skillCfg.watch !== undefined ? !!skillCfg.watch : true,
      },
      { control, warn: (m) => console.warn(m) }
    )
  );
  setSkillsRegistry(registry);
  return registry;
}

function resolveContextWindow(opts) {
  return config.resolveContextWindow(opts);
}

module.exports = { createCore, AgentRuntime, resolveWorkspaceFolder, resolveContextWindow };
