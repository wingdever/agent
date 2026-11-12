"use strict";
const tokenMeter = require("./token-meter");

// 把底层模型的 usage 对象标准化后上报（兼容字段缺失 / 不同厂商命名）。
// cached_tokens 可能嵌在 prompt_tokens_details 内，也可能直接给顶层。
// 从 AgentCore._emitUsage 抽出：纯函数，不依赖 core 实例。
function emitUsage(onEvent, raw) {
  if (!raw || typeof raw !== "object") return;
  const details = raw.prompt_tokens_details || {};
  const cached = (typeof raw.cached_tokens === "number") ? raw.cached_tokens
    : (typeof details.cached_tokens === "number" ? details.cached_tokens : null);
  onEvent({
    type: "usage",
    promptTokens: raw.prompt_tokens != null ? raw.prompt_tokens : null,
    completionTokens: raw.completion_tokens != null ? raw.completion_tokens : null,
    totalTokens: raw.total_tokens != null ? raw.total_tokens : null,
    cachedTokens: cached,
  });
}

// 单次模型调用（流式或非流式），返回标准化后的 assistant 消息。
// 从 AgentCore._stream 抽出；依赖 core 的 _post / reasoningParamFor / effort / model / baseUrl。
async function stream(core, { messages, toolDefs, model, onEvent, sessionId, stream = false, maxTokens, baseUrl, apiKey, effort }) {
  onEvent({ type: "model-http-status", state: "on-post" });
  const payload = { model: model || core.model, messages, stream: !!stream, tools: toolDefs };
  // 摘要调用使用 DSH 同款生成上限（8192）；普通对话不带 max_tokens。
  if (maxTokens != null) payload.max_tokens = maxTokens;
  // 推理等级（DSH effort-selector）按 provider 的 reasoning_param 翻译为 provider 字段：
  //   none（关闭推理）-> reasoning_param==="thinking" 时发 {"thinking":{"type":"disabled"}}；
  //                     否则发 {"reasoning_effort":"none"}（radeon / OpenAI 等原生关闭档）
  //   其他等级        -> reasoning_param!=="none" 时发 {"reasoning_effort":"xxx"}
  // 摘要调用显式传 effort:null（DSH 的 summarization 请求不带 effort）。
  // 兼容旧值 "off"：与 "none" 同义（历史 settings.effort 可能为 "off"）。
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
  const { stream: res, cap } = await core._post(payload, sessionId, baseUrl, apiKey);
  onEvent({ type: "model-http-status", state: "on-get", status: cap.status });
  const { trackCapture } = require("./network/http/client");
  trackCapture(res, cap);

  if (!stream) {
    // Non-streaming: read the full JSON response and extract the message.
    let raw = "";
    await new Promise((resolve, reject) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", resolve);
      res.on("error", reject);
    });
    let json;
    try { json = JSON.parse(raw); }
    catch (e) { throw new Error("bad JSON response: " + raw.slice(0, 400)); }
    const choice = (json.choices && json.choices[0]) || {};
    const msg = choice.message || {};
    const content = msg.content || "";
    const reasoning_content = msg.reasoning_content || "";
    const tool_calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
      ? msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: (tc.function && tc.function.name) || "", arguments: (tc.function && tc.function.arguments) || "" },
        }))
      : undefined;
    if (reasoning_content) onEvent({ type: "reasoning", delta: reasoning_content });
    if (content) onEvent({ type: "token", delta: content });
    // 上报 token 用量（非流式响应直接在 json.usage）；同时把标准化 usage
    // 返回给 chat()，供 token-meter 记录 provider usage 锚点。
    if (json.usage) emitUsage(onEvent, json.usage);
    return {
      role: "assistant", content, reasoning_content, tool_calls,
      finish_reason: choice.finish_reason || null,
      usage: json.usage ? tokenMeter.normalizeUsage(json.usage) : null,
    };
  }

  // Streaming (SSE): parse each data: line into deltas + tool calls.
  let buf = "", content = "", reasoning_content = "", acc = {}, finishReason = null, lastUsage = null;
  await new Promise((resolve, reject) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.indexOf("data:") !== 0) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let o; try { o = JSON.parse(data); } catch (_) { continue; }
        const choice = (o.choices && o.choices[0]) || {};
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (o.usage) lastUsage = o.usage;  // 用量通常随最后一个 chunk 下发
        const d = choice.delta || {};
        if (d.reasoning_content) { reasoning_content += d.reasoning_content; onEvent({ type: "reasoning", delta: d.reasoning_content }); }
        if (d.content) { content += d.content; onEvent({ type: "token", delta: d.content }); }
        if (d.tool_calls) for (const tc of d.tool_calls) {
          const k = tc.index;
          if (!acc[k]) acc[k] = { id: tc.id, name: (tc.function && tc.function.name) || "", args: "" };
          if (tc.id) acc[k].id = tc.id;
          if (tc.function && tc.function.name) acc[k].name = tc.function.name;
          if (tc.function && tc.function.arguments) acc[k].args += tc.function.arguments;
        }
      }
    });
    res.on("end", () => { if (lastUsage) emitUsage(onEvent, lastUsage); resolve(); }); res.on("error", reject);
  });
  const tool_calls = Object.keys(acc).length
    ? Object.keys(acc).map((k) => ({ id: acc[k].id, type: "function", function: { name: acc[k].name, arguments: acc[k].args } }))
    : undefined;
  return {
    role: "assistant", content, reasoning_content, tool_calls, finish_reason: finishReason,
    usage: lastUsage ? tokenMeter.normalizeUsage(lastUsage) : null,
  };
}

module.exports = { stream, emitUsage };
