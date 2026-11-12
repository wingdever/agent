"use strict";

// 流式输出渲染层：把模型增量渲染为 UI 事件。
// 非流式把整段 content / reasoning 当单个 delta 渲染；流式逐片渲染（live）。
// 两者走同一个 renderDelta，对下游 handler 无差别——chat-tab.onChatEvent 对
// token 是纯追加语义（AgentMarkdown.append(ensureAnswer(), evt.delta)）。
// 该层只负责「怎么把增量变成事件」，不累积、不解析，累积与解析在 response-process。
function renderDelta(onEvent, kind, delta) {
  if (!delta) return;
  onEvent({ type: kind === "reasoning" ? "reasoning" : "token", delta });
}

module.exports = { renderDelta };
