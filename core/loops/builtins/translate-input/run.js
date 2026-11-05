"use strict";

// 二级预定义节点 builtin.translate-input（type: builtin，不在默认 next 链上）。
// 中→英输入翻译：翻译最后一条 user 消息，失败阻断整轮（与 linear 一致 —— 模型只应看到英文）。
// 由挂在 resolve-input.before 的普通 hook 调用（见 node-graph.js 的 translate 注入）。

const translation = require("../../../translation");
const { TurnError } = require("../../../turn-error");

module.exports = async function run(input, ctx) {
  const { onEvent } = ctx;
  const messages = ctx.messages;
  const last = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  if (!last || last.role !== "user" || !translation.shouldTranslateUser(last.content, ctx.translateCfg)) {
    ctx.translatedUser = null; // 显式声明未翻译，供 resolve-input 区分
    return { output: input };
  }
  onEvent({ type: "translation", role: "user", phase: "start", sourceLang: "zh", targetLang: "en", source: last.content });
  try {
    const translated = await translation.translateText({
      text: last.content,
      target: "en",
      config: ctx.translateCfg,
      sessionId: ctx.sessionId,
      timeoutMs: ctx.translateCfg.inputTimeoutMs,
    });
    onEvent({ type: "translation", role: "user", phase: "done", sourceLang: "zh", targetLang: "en", source: last.content, text: translated });
    ctx.translatedUser = translated;
  } catch (e) {
    const message = String((e && e.message) || e);
    onEvent({ type: "translation", role: "user", phase: "error", sourceLang: "zh", targetLang: "en", source: last.content, error: message });
    throw new TurnError("translation-error", "input translation failed: " + message);
  }
  return { output: input };
};
