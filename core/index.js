"use strict";

// Composition root. Services are created here and returned on a flat `core`
// object; there is intentionally no core.chat / core.approve facade.

import path from "path";
import config from "./config/index.js";
import { ModelService } from "./model/index.js";
import { ContextService } from "./context/index.js";
import { InteractionService } from "./interactions/index.js";
import { ToolService } from "./tools/index.js";
import { AgentRuntime } from "./agent.js";
import { SubagentRuntime } from "./subagent-runtime.js";
import { createWorkflowService } from "./workflow/index.js";
import { JobService } from "./jobs/index.js";
import { TeamService } from "./team/index.js";
import { ScheduleService } from "./schedule/index.js";
import { A2AService } from "./a2a/index.js";
import { BrowserService } from "./browser/index.js";
import { createFlowService } from "./flow/index.js";
import { runTool } from "./tools/executor.js";
import { createCapabilities } from "./capabilities.js";
import { createRpc } from "./rpc/index.js";
import { loadTools } from "./tools/registry.js";
import { createGoalService } from "./goals.js";
import _mod0 from "./skills/index.js";
const { SkillRegistry,
  FileSystemSkillProvider,
  setSkillsRegistry, } = _mod0;
import { resolveWorkspaceFolder } from "./context/workspace.js";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __pathDirname } from "node:path";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));


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

  const { createStore } = await import("./storage/store.js");
  const store = await createStore();
  const tools = new ToolService(await loadTools());
  const goals = createGoalService(store);
  const interactions = new InteractionService({ store });
  const model = new ModelService({ config });
  const skills = createSkillsRegistry();

  const context = new ContextService({ config, model, tools, skills, store });
  const agent = new AgentRuntime({ config, model, context, tools, skills, interactions, store, goals });

  // Slots are composed by the entry layer and handed in: core never imports
  // proxies/ or channels/. Tools reach them only through these handles.
  const capabilities = createCapabilities({
    proxies: overrides.proxies || [],
    channels: overrides.channels || null,
  });

  const core = {
    config,
    model,
    context,
    tools,
    skills,
    interactions,
    agent,
    capabilities,
    subagents: null,
    workflow: null,
    jobs: null,
    team: null,
    schedule: null,
    a2a: null,
    browser: null,
    flow: null,
    store,
    goals,
    rpc: null,
  };
  agent.setCore(core);
  agent.setSubagents(() => core.subagents);
  context.setRuntime(agent);
  core.subagents = new SubagentRuntime(core);
  // Team reuses the subagent tree as membership; the board is rooted at the
  // tree's root session and is shared by every descendant.
  core.team = new TeamService({
    store,
    subagents: () => core.subagents,
  });
  core.agent.setTeam(core.team);
  // Background jobs settle into a follow-up turn in the owning session, exactly
  // like a subagent settlement. The service is created after the runtime so the
  // resume path can reach every session instance.
  core.jobs = new JobService({
    store,
    getAgent: (sessionId) => core.agent.get(sessionId),
    resume: (ctx) => core.agent.chat(ctx),
  });
  core.agent.setJobs(core.jobs);
  await core.jobs.init();
  // Workflow runs read limits from user/settings.json's `workflow` block lazily,
  // so a settings edit applies to the next run without a restart.
  core.workflow = createWorkflowService({ config, getSubagents: () => core.subagents });
  // Browser automation is optional and lazy: Chromium starts on the first tool
  // call, never at core construction. Sessions own isolated contexts.
  core.browser = new BrowserService({ logger: console });
  // Flows are user-edited graphs run by the local backend; they never touch an
  // Agent instance (docs/flow/flow.md).
  core.flow = createFlowService({ store, model, config, tools, runTool, capabilities, browser: core.browser });
  interactions.setRegistry(agent.registry);
  core.rpc = createRpc(core);
  // Scheduled tasks are Host-level timers, not Jobs: they persist a rule and
  // deliver a user follow-up when due. Created last so a due task's first timer
  // callback cannot fire before workflow/flow/rpc exist.
  core.schedule = new ScheduleService({
    store,
    resume: (ctx) => core.agent.chat(ctx),
  });
  await core.schedule.init();
  // A2A is an edge adapter over the same agent runtime. It owns no timers or
  // background workers; the HTTP server entry starts it explicitly.
  core.a2a = new A2AService({ store, agent: core.agent, interactions, logger: console });
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

const __exports = { createCore, AgentRuntime, resolveWorkspaceFolder, resolveContextWindow };
export { createCore, AgentRuntime, resolveWorkspaceFolder, resolveContextWindow };
export default __exports;
