"use strict";
const { postChatCompletions, trackCapture } = require("./network/http/client");

// 模型请求发出层（model-call 模块三子模块之一）：构造 Chat Completions payload
// （含推理等级翻译）并调用 HTTP transport 取响应。从 AgentCore._post（原挂在
// AgentCore）与 response-process.js 的「构造 payload」部分抽出，使 response-process.js
// 只关心「怎么读响应」，不关心「怎么发请求」。
//
// stream-refactor 的 issueRequest：构造 payload + POST 取响应
// （流式或非流式只是「怎么取」不同，由调用方通过 stream 标志决定）。

// 构造 payload：模型 / messages / 工具 / 可选 max_tokens，并把 effort 翻译为
// provider 专属推理字段。推理等级（DSH effort-selector）按 provider 的
// reasoning_param 翻译：
//   none（关闭推理）-> reasoning_param==="thinking" 时发 {"thinking":{"type":"disabled"}}；
//                     否则发 {"reasoning_effort":"none"}（radeon / OpenAI 等原生关闭档）
//   其他等级        -> reasoning_param!=="none" 时发 {"reasoning_effort":"xxx"}
// 摘要调用显式传 effort:null（DSH 的 summarization 请求不带 effort）。
// 兼容旧值 "off"：与 "none" 同义（历史 settings.effort 可能为 "off"）。
function buildPayload(core, { messages, toolDefs, model, maxTokens, baseUrl, effort, stream }) {
  const payload = { model: model || core.model, messages, stream: !!stream, tools: toolDefs };
  // 摘要调用使用 DSH 同款生成上限（8192）；普通对话不带 max_tokens。
  if (maxTokens != null) payload.max_tokens = maxTokens;
  const effectiveEffort = effort === undefined ? core.effort : effort;
  if (effectiveEffort) {
    const rp = core.reasoningParamFor(baseUrl || core.baseUrl);
    if (effectiveEffort === "none" || effectiveEffort === "off") {
      if (rp === "thinking") payload.thinking = { type: "disabled" };
      else if (rp !== "none") payload.reasoning_effort = "none";
    } else if (rp !== "none") {
      payload.reasoning_effort = effectiveEffort;
    }
  }
  return payload;
}

// issueRequest：构造 payload 并 POST，返回仍处于暂停态的响应流与捕获元数据。
// trackCapture 在此挂到响应流上（client.js 约定：OK 路径由调用方挂 parser + capture，
// 流在两者都挂上之前不会流动，故不丢 chunk）。
async function issueRequest(core, { messages, toolDefs, model, maxTokens, baseUrl, apiKey, effort, sessionId, stream }) {
  const payload = buildPayload(core, { messages, toolDefs, model, maxTokens, baseUrl, effort, stream });
  const { stream: res, cap } = await postChatCompletions({
    baseUrl: baseUrl || core.baseUrl,
    apiKey: apiKey || core.apiKey,
    payload,
    sessionId,
  });
  trackCapture(res, cap);
  return { res, cap };
}

module.exports = { issueRequest, buildPayload };
