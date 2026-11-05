"use strict";

// 节点 assemble-system：首轮装配 system prompt（仅持久化会话的首 turn 装配并存库一次，
// 之后复用存储文本）。与 linear 的 assembleSystemPrompt 调用一致。

const { DEFAULT_IDENTITY, assembleSystemPrompt } = require("../../../system-prompt");
const { readSettings } = require("../../shared");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  const st = readSettings();
  const persist = ctx.persist;
  let system = persist ? await core.store.run("session.prompt", { session_id: ctx.sessionId }) : null;
  const systemIsNew = !system;
  if (systemIsNew) {
    system = assembleSystemPrompt({
      identity: typeof st.identity === "string" ? st.identity : DEFAULT_IDENTITY,
      persona: typeof st.persona === "string" ? st.persona : "",
      tools: ctx.tools,
      cwd: ctx.cwd,
      model: ctx.effModel,
    }).system;
    onEvent({ type: "system-prompt", content: system });
  }
  ctx.system = system;
  ctx.systemIsNew = systemIsNew;
  return { output: system, next: "build-context" };
};
