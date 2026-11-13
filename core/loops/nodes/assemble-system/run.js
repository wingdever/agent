"use strict";

// 节点 assemble-system：首轮装配 system prompt（仅持久化会话的首 turn 装配并存库一次，
// 之后复用存储文本）。与 linear 的 assembleSystemPrompt 调用一致。

const { DEFAULT_IDENTITY, assembleSystemPrompt } = require("../../../system-prompt");
const { isModelInvocable } = require("../../../skills");
const { readSettings } = require("../../shared");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  const st = readSettings();
  const persist = ctx.persist;
  let system = persist ? await core.store.run("session.prompt", { session_id: ctx.sessionId }) : null;
  const systemIsNew = !system;
  let catalogMsg = null;
  if (systemIsNew) {
    // 会话起始一次性装配 system 文本 + skill 目录消息（user-role）。目录只包含
    // 可模型调用的 skill；之后所有轮次从存储读回，不再重新生成。
    const skills = core.skills
      ? (await core.skills.list({ cwd: ctx.cwd })).filter((s) => isModelInvocable(s))
      : [];
    const assembled = assembleSystemPrompt({
      identity: typeof st.identity === "string" ? st.identity : DEFAULT_IDENTITY,
      persona: typeof st.persona === "string" ? st.persona : "",
      tools: ctx.tools,
      cwd: ctx.cwd,
      model: ctx.effModel,
      skills,
      catalogDescriptionMaxLength: st.skills ? st.skills.catalogDescriptionMaxLength : undefined,
    });
    system = assembled.system;
    if (assembled.block.length > 1) catalogMsg = assembled.block[1];
    onEvent({ type: "system-prompt", content: system });
  }
  ctx.system = system;
  ctx.systemIsNew = systemIsNew;
  ctx.catalogMsg = catalogMsg;
  return { output: system, next: "build-context" };
};
