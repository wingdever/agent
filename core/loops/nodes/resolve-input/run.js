"use strict";

// 节点 resolve-input：取最后一条 user、解析 references / workspace，选定工具与权限，
// 准备 pendingUser / pendingRefs，并建好本轮 turn（持久化会话）。
// 输入翻译（中→英）由挂在 before 槽的 translate hook 完成（设置 ctx.translatedUser），
// 本节点读取该值；未启用翻译时 ctx.translatedUser 为 null（即直接用原文）。

const { readPermissions, permissionFor } = require("../../../permissions");
const { readFsPolicy } = require("../../../fs-policy");
const { resolveConfig: resolveTranslateConfig } = require("../../../translation");
const { readSettings } = require("../../shared");
const { prepareUserInput } = require("../../../user-input");
const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { core, onEvent } = ctx;
  const st = readSettings();
  ctx.translateCfg = resolveTranslateConfig(st);

  // 工具选择（确定性顺序，与 linear 一致）。
  const tools = core._selectTools(ctx.toolNames);
  ctx.tools = tools;
  ctx.toolDefs = core._toolDefs(tools);
  ctx.permissions = readPermissions();
  ctx.fsPolicy = readFsPolicy();

  // 工作区 cwd / 最后一条 user 校验。
  ctx.cwd = await core._resolveCwd(ctx.persist ? ctx.sessionId : null);

  const messages = ctx.messages;
  const lastInput = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  if (!lastInput || lastInput.role !== "user") {
    throw new (require("../../../turn-error").TurnError)("invalid-input", "the last message must be a user message");
  }

  // pendingUser：翻译由 hook 注入到 ctx.translatedUser；否则原文。
  ctx.pendingUser = { role: "user", content: ctx.translatedUser != null ? ctx.translatedUser : lastInput.content };
  // @引用：把引用文件/会话内容作为上下文注入（独立于翻译步骤）。
  // 由 core/user-input 统一准备，两条 loop 路径共用同一份输入准备逻辑。
  ctx.pendingRefs = await prepareUserInput(core, { references: ctx.references, sessionId: ctx.sessionId, persist: ctx.persist });

  // 持久化会话：建 turn（一个 turn 包含多个 step）。
  ctx.userPersisted = false;
  if (ctx.persist) {
    const turns = await core.store.run("turn.list", { session_id: ctx.sessionId });
    ctx.turn = await core.store.run("turn.create", {
      session_id: ctx.sessionId,
      seq: turns.length,
      status: "running",
    });
  }

  // r 为 step 循环计数（与 linear 的 for(;;r++) 对应），从 0 起。
  ctx.r = 0;
  return { output: ctx.pendingUser, next: "resolve-model" };
};
