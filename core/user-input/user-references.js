"use strict";
const fs = require("fs");
const path = require("path");
const { isUserInvocable, renderSkillContent } = require("../skills");

// 解析引用上下文（文件 / 会话 / 技能），拼成注入 system 的引用块。
// 从 AgentCore._resolveReferences 抽出，现作为 core/user-input 的子模块；
// 依赖 core.store（读会话轨迹）与 core.skills（技能引用渲染）。
async function resolveReferences(core, references, sessionId, cwd) {
  const MAX_FILE = 20000; // 单文件上限，避免超长上下文
  const parts = []; // 文件 / 会话引用块
  const skillParts = []; // 技能引用块（<skill_content> 指令，拼在末尾）
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
    } else if (ref.type === "skill" && typeof ref.name === "string") {
      // 技能引用块：与 /name 手势共用 renderSkillContent 模板，但来源是 references
      // 参数（@菜单 chip）而非文本解析；门控同样是 isUserInvocable。渲染为
      // <skill_content> 指令块，收集到 skillParts，最后拼在引用上下文消息末尾
      // （指令最靠近回答，与手势注入位置一致）。
      try {
        const registry = core && core.skills;
        if (!registry || typeof registry.list !== "function" || typeof registry.get !== "function") {
          skillParts.push(`[引用技能] ${ref.name}（技能注册表不可用）`);
        } else {
          const lookup = { cwd };
          const summary = (await registry.list(lookup)).find((s) => s.name === ref.name);
          if (!summary || !isUserInvocable(summary)) {
            skillParts.push(`[引用技能] ${ref.name}（未找到或不可用户调用）`);
          } else {
            const skill = await registry.get(ref.name, lookup);
            if (!skill || !isUserInvocable(skill)) {
              skillParts.push(`[引用技能] ${ref.name}（未找到或不可用户调用）`);
            } else {
              skillParts.push(renderSkillContent(skill));
            }
          }
        }
      } catch (e) {
        skillParts.push(`[引用技能] ${ref.name}（解析失败：${e.message}）`);
      }
    }
  }
  const allParts = parts.concat(skillParts);
  return allParts.length ? "以下为本次对话的引用上下文，请基于其内容回答：\n\n" + allParts.join("\n\n") : "";
}

module.exports = { resolveReferences };
