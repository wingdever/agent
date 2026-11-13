"use strict";

// 用户输入准备：把 UI 传来的 references 解析为可注入对话的上下文消息块。
// user-references 是本模块的引用解析子模块；将来其余输入归一化（如引用文本解析）
// 也可并入此处，统一由两条 loop 路径调用，避免重复的输入准备逻辑。

const { resolveReferences } = require("./user-references");

// 准备本轮用户输入的注入上下文，返回 { refs }：
// - refs：@引用（文件 / 会话 / 技能，见 user-references.js）解析出的 user 消息数组
//   （每条 { role: "user", content }）。
// 两套 loop 路径共用本入口；无引用或解析失败时返回空数组。
// 仅持久化会话（persist 且 core.store 存在）才注入引用。
// 注：dsh 的 /name 文本手势属于 dsh 用户习惯，不属于本系统与模型的通信契约，
// 本项目不实现（见 docs/dev/skill.md 5.3）。
async function prepareUserInput(core, { text, cwd, references, sessionId, persist }) {
  const refs = [];
  if (Array.isArray(references) && references.length && persist && core.store) {
    try {
      const refBlock = await resolveReferences(core, references, sessionId, cwd);
      if (refBlock) refs.push({ role: "user", content: refBlock });
    } catch (e) {
      console.error("[core] resolve references failed:", e.message);
    }
  }
  return { refs };
}

module.exports = { prepareUserInput };
