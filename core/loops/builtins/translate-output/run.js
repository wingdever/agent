"use strict";

// 二级预定义节点 builtin.translate-output（type: builtin，不在默认 next 链上）。
// 英→中输出翻译：**仅最终回答**（有 tool_calls 的模型响应不翻译，history 保持英文）。
// 翻译只发事件、不改 message（UI 用 translation 事件展示中文，历史/下游仍用英文）。
// 由挂在 model-request.after 的普通 hook 调用（见 node-graph.js 的 translate 注入）。

const translation = require("../../../translation");

module.exports = async function run(input, ctx) {
  const { onEvent } = ctx;
  const message = ctx.message;
  // 仅最终回答（无 tool_calls、且非截断）才翻译；带工具调用的模型响应与截断响应不翻译，
  // history 保持英文。tool_calls 为 undefined 表示无调用，应翻译；仅当为「非空数组」时跳过。
  if (!message) return { output: input };
  if (message.finish_reason === "length") return { output: input };
  if (message.tool_calls && message.tool_calls.length) return { output: input };
  if (!translation.shouldTranslateAssistant(message.content, ctx.translateCfg)) {
    return { output: input };
  }
  onEvent({ type: "translation", role: "assistant", phase: "start", sourceLang: "en", targetLang: "zh", source: message.content });
  try {
    const translated = await translation.translateText({
      text: message.content,
      target: "zh",
      config: ctx.translateCfg,
      sessionId: ctx.sessionId,
      timeoutMs: ctx.translateCfg.outputTimeoutMs,
    });
    onEvent({ type: "translation", role: "assistant", phase: "done", sourceLang: "en", targetLang: "zh", source: message.content, text: translated });
  } catch (e) {
    onEvent({
      type: "translation",
      role: "assistant",
      phase: "error",
      sourceLang: "en",
      targetLang: "zh",
      source: message.content,
      error: String((e && e.message) || e),
    });
  }
  return { output: input };
};
