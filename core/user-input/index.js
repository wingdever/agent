"use strict";

// 用户输入准备：把 UI 传来的 references 解析为可注入对话的上下文消息块。
// user-references 是本模块的引用解析子模块；将来其余输入归一化（如引用文本解析）
// 也可并入此处，统一由两条 loop 路径调用，避免重复的输入准备逻辑。

const { resolveReferences } = require("./user-references");

// 准备本轮用户输入的引用上下文，返回待注入的 user 消息数组
// （每条为 { role: "user", content: refBlock }）。无引用或解析失败时返回 []。
// 仅持久化会话（persist 且 core.store 存在）才注入。
async function prepareUserInput(core, { references, sessionId, persist }) {
  const pendingRefs = [];
  if (Array.isArray(references) && references.length && persist && core.store) {
    try {
      const refBlock = await resolveReferences(core, references, sessionId);
      if (refBlock) pendingRefs.push({ role: "user", content: refBlock });
    } catch (e) {
      console.error("[core] resolve references failed:", e.message);
    }
  }
  return pendingRefs;
}

module.exports = { prepareUserInput };
