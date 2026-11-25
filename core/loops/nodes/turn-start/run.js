"use strict";

// Node turn-start: initialize the turn, session gates and tool/permission
// selection. This is the only node that claims the active session.
import path from "path";
import { readPermissions } from "./../../../permissions.js";
import _mod0 from "./../../../fs-policy.js";
const { readFsPolicy } = _mod0;
import { resolveExecutorMode, selectForExecutor } from "./../../../executor-mode.js";
import { reset as resetTodos } from "./../../../../lib/todo-state/index.js";

export default async function run(input, ctx) {
  const { agent, services, session, turn } = ctx;
  // Delivery state for this turn lives on the instance; beginTurn already
  // installed it (node-graph owns opening and closing the turn).
  if (session.id) agent.setPlanMode(agent.turn.activity === "plan-mode");

  if (session.persist) {
    const gate = agent.gates.compacting.get(String(session.id));
    if (gate) await gate;
    agent.gates.activeSessions.add(String(session.id));
  }
  resetTodos(agent);


  const settings = services.config.readSettings();
  ctx.translateCfg = services.context.resolveTranslateConfig(settings);

  ctx.executorMode = resolveExecutorMode();
  const selection = selectForExecutor(services.tools, ctx.toolNames, ctx.executorMode);
  ctx.request.selected = selection.selected;
  ctx.request.nestedToolNames = selection.nestedToolNames;
  ctx.request.sdkTools = selection.sdkTools;
  ctx.request.toolDefs = services.tools.defs(ctx.request.selected);
  ctx.request.permissions = readPermissions();
  ctx.request.fsPolicy = readFsPolicy();

  const baseCwd = await services.context.resolveCwd(session.persist ? session.id : null);
  ctx.cwd = ctx.input.cwd ? path.resolve(baseCwd, ctx.input.cwd) : baseCwd;

  if (session.persist) {
    const turns = await services.store.run("turn.list", { session_id: session.id });
    turn.row = await services.store.run("turn.create", {
      session_id: session.id,
      seq: turns.length,
      status: "running",
    });
    turn.stepSeq = 0;
  }

  return { output: ctx, next: "resolve-target" };
};
