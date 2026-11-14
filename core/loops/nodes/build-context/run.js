"use strict";

// 节点 build-context：拼装本轮请求消息 conv（surface + refs + user）。
// - 持久化会话：conv 由 core._requestMessages 从存储 surface 投影 + pending 尾部。
// - bare-chat：内存 messages；若翻译过则仅替换最后一条 user 为英文。
// 同时记录 pendingTurnMessages（r=0 且未落库时供自动压缩重建历史用）。

const planMode = require("../../../plan-mode");

module.exports = async function run(input, ctx) {
  const { core } = ctx;
  const persist = ctx.persist;
  let conv;
  if (persist) {
    conv = await core._requestMessages(ctx.sessionId, ctx.system, [...ctx.pendingRefs, ctx.pendingUser]);
  } else {
    conv = [{ role: "system", content: ctx.system }, ...ctx.messages];
    if (ctx.catalogMsg) conv.splice(1, 0, ctx.catalogMsg);
    if (ctx.translatedUser != null && conv.length > 1) {
      conv[conv.length - 1] = Object.assign({}, conv[conv.length - 1], { content: ctx.translatedUser });
    }
  }
  // runtime-context（子 Agent 权限声明等）：作为独立的 user 消息注入 conv，
  // 只影响本次请求的模型上下文、不落库（父子 system prompt 保持一致）。
  // 插在最后一条 user（本次输入）之前，而不是 system 之后：fork 的继承段必须与
  // 父会话的前缀逐字相同才能命中前缀缓存，插在头部会让整段继承历史失去缓存。
  if (Array.isArray(ctx.contextMessages) && ctx.contextMessages.length) {
    const last = conv.length - 1;
    const at = last > 0 && conv[last] && conv[last].role === "user" ? last : 1;
    conv.splice(at, 0, ...ctx.contextMessages);
  }
  ctx.conv = conv;
  // r=0 落库前的尾部消息构造器：自动压缩重建历史时追加，落库后不再追加。
  ctx.pendingTurnMessages = () =>
    ctx.r === 0 && !ctx.userPersisted ? [...ctx.pendingRefs, ctx.pendingUser] : [];
  return { output: conv, next: "auto-compact" };
};
