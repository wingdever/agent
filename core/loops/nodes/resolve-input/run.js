"use strict";

// 节点 resolve-input：取最后一条 user、解析 references / workspace，选定工具与权限，
// 准备 pendingUser / pendingRefs，并建好本轮 turn（持久化会话）。
// 输入翻译（中→英）由挂在 before 槽的 translate hook 完成（设置 ctx.translatedUser），
// 本节点读取该值；未启用翻译时 ctx.translatedUser 为 null（即直接用原文）。

const path = require("path");
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

  // 工作区 cwd / 最后一条 user 校验。ctx.cwd 覆盖：子 Agent 委派可带初始工作目录
  // （相对路径基于父当前目录）。
  const baseCwd = await core._resolveCwd(ctx.persist ? ctx.sessionId : null);
  ctx.cwd = ctx.cwd ? path.resolve(baseCwd, ctx.cwd) : baseCwd;

  const messages = ctx.messages;
  const lastInput = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  if (!lastInput || lastInput.role !== "user") {
    throw new (require("../../../turn-error").TurnError)("invalid-input", "the last message must be a user message");
  }

  // pendingUser：翻译由 hook 注入到 ctx.translatedUser；否则原文。
  ctx.pendingUser = { role: "user", content: ctx.translatedUser != null ? ctx.translatedUser : lastInput.content };
  // @引用：由 core/user-input 统一准备，两条 loop 路径共用同一份输入准备逻辑。
  // dsh 的 /name 文本手势不实现（见 docs/dev/skill.md 5.3）。
  const { refs } = await prepareUserInput(core, {
    text: lastInput.content,
    cwd: ctx.cwd,
    references: ctx.references,
    sessionId: ctx.sessionId,
    persist: ctx.persist
  });
  ctx.pendingRefs = refs;

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
