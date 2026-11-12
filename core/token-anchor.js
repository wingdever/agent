"use strict";
const tokenMeter = require("./token-meter");

// Record the DSH usage anchor after one successful response.
// 从 AgentCore._recordTokenAnchor 抽出：纯数据落库逻辑，依赖 core.store 与 tokenMeter。
async function recordTokenAnchor(core, { sessionId, model, system, tools, messages, assistant, usage }) {
  if (!core.store || !sessionId) return null;
  try {
    const anchor = tokenMeter.anchorFrom({ messages, assistant, system, tools, model, usage });
    return await core.store.run("tokenAnchor.save", {
      session_id: sessionId,
      header_key: anchor.headerKey,
      header_tokens: anchor.headerTokens,
      input_tokens: anchor.inputTokens,
      assistant_tokens: anchor.assistantTokens,
      usage_total: anchor.usageTotal,
    });
  } catch (error) {
    console.warn("[token-meter] anchor save failed:", (error && error.message) || error);
    return null;
  }
}

module.exports = { recordTokenAnchor };
