"use strict";
const { postChatCompletions, trackCapture } = require("./network/http/client");

// Model request layer: build the Chat Completions payload (including the
// provider-specific reasoning fields) and POST it. All credentials and the
// target model arrive explicitly; nothing is read from a global core object.

function buildPayload(modelService, { messages, toolDefs, model, maxTokens, baseUrl, effort, stream }) {
  const payload = { model, messages, stream: !!stream, tools: toolDefs };
  if (maxTokens != null) payload.max_tokens = maxTokens;
  if (effort) {
    const rp = modelService.reasoningParamFor(baseUrl);
    if (effort === "none" || effort === "off") {
      if (rp === "thinking") payload.thinking = { type: "disabled" };
      else if (rp !== "none") payload.reasoning_effort = "none";
    } else if (rp !== "none") {
      payload.reasoning_effort = effort;
    }
  }
  return payload;
}

async function issueRequest(modelService, {
  messages,
  toolDefs,
  model,
  maxTokens,
  baseUrl,
  apiKey,
  effort,
  sessionId,
  stream,
}) {
  const payload = buildPayload(modelService, { messages, toolDefs, model, maxTokens, baseUrl, effort, stream });
  const { stream: res, cap } = await postChatCompletions({
    baseUrl,
    apiKey,
    payload,
    sessionId,
  });
  trackCapture(res, cap);
  return { res, cap };
}

module.exports = { issueRequest, buildPayload };
