"use strict";
const fs = require("fs");
const path = require("path");

// 解析引用上下文（文件 / 会话），拼成注入 system 的引用块。
// 从 AgentCore._resolveReferences 抽出，现作为 core/user-input 的子模块；
// 依赖 core.store（读会话轨迹）。
async function resolveReferences(core, references, sessionId) {
  const MAX_FILE = 20000; // 单文件上限，避免超长上下文
  const parts = [];
  for (const ref of references) {
    if (!ref || typeof ref !== "object") continue;
    if (ref.type === "file" && typeof ref.path === "string") {
      try {
        const abs = path.resolve(ref.path);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) { parts.push(`[引用目录] ${ref.path}（目录，未读取内容）`); continue; }
        const content = fs.readFileSync(abs, "utf8");
        const trimmed = content.length > MAX_FILE ? content.slice(0, MAX_FILE) + `\n…(截断，原 ${content.length} 字符)` : content;
        parts.push(`[引用文件] ${ref.path}\n\`\`\`\n${trimmed}\n\`\`\``);
      } catch (e) {
        parts.push(`[引用文件] ${ref.path}（读取失败：${e.message}）`);
      }
    } else if (ref.type === "session" && ref.id != null) {
      try {
        const tree = await core.store.run("session.trajectory", { session_id: ref.id });
        const name = (ref.name || ("会话 " + ref.id));
        let excerpt = "";
        let turns = 0, steps = 0, calls = 0;
        (tree || []).forEach((t) => { turns++; (t.steps || []).forEach((s) => { steps++; (s.calls || []).forEach((c) => { calls++; excerpt += `- 工具 ${c.name}: ${String(c.description || c.arguments || "").slice(0, 200)}\n`; }); if (s.messages) s.messages.forEach((m) => { if (m.content && m.role === "user") excerpt += `用户: ${String(m.content).slice(0, 300)}\n`; if (m.content && m.role === "assistant") excerpt += `助手: ${String(m.content).slice(0, 300)}\n`; }); }); });
        parts.push(`[引用会话] ${name}（${turns} turns / ${steps} steps / ${calls} 工具调用）\n${excerpt.slice(0, MAX_FILE)}`);
      } catch (e) {
        parts.push(`[引用会话] ${ref.id}（读取失败：${e.message}）`);
      }
    }
  }
  return parts.length ? "以下为本次对话的引用上下文，请基于其内容回答：\n\n" + parts.join("\n\n") : "";
}

module.exports = { resolveReferences };
