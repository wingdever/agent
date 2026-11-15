"use strict";

// Node turn-start: initialize the turn, session gates and tool/permission
// selection. This is the only node that claims the active session.
const path = require("path");
const { readPermissions } = require("../../../permissions");
const { readFsPolicy } = require("../../../fs-policy");
const planMode = require("../../../plan-mode");
const { reset: resetTodos } = require("../../../todo-state");

module.exports = async function run(input, ctx) {
  const { runtime, services, session, turn } = ctx;
  runtime.beginTurn({ emit: ctx.emit, autonomy: ctx.autonomy });
  runtime.effort = ctx.effort && ctx.effort !== "undefined" ? ctx.effort : null;
  runtime.activity = ctx.activity === "plan-mode" ? "plan-mode" : (ctx.activity || "bare-chat");
  if (session.id) planMode.setActive(session.id, runtime.activity === "plan-mode");

  if (session.persist) {
    const gate = runtime.compacting.get(String(session.id));
    if (gate) await gate;
    runtime.activeSessions.add(String(session.id));
  }
  resetTodos(session.id);

  const settings = services.config.readSettings();
  ctx.translateCfg = services.context.resolveTranslateConfig(settings);

  ctx.tools.selected = services.tools.select(ctx.toolNames);
  ctx.tools.defs = services.tools.defs(ctx.tools.selected);
  ctx.tools.permissions = readPermissions();
  ctx.tools.fsPolicy = readFsPolicy();

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
