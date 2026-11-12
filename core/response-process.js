"use strict";
const tokenMeter = require("./token-meter");
const { issueRequest } = require("./model-request");
const { renderDelta } = require("./stream-render");

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

// model-call 模块三个子模块：
//   model-request.js  发起请求（构造 payload + effort 翻译 + POST）
//   response-process.js（本文件）响应读取（解析 + 累积 + 归一化）
//   stream-render.js  流式输出渲染（增量 -> UI 事件）
//
// 流式 = 非流式 + 增量渲染：两分支最终都收敛到同一归一化对象（finalize），
// 共享同一个累积器 `acc`。`feed` 是唯一的 delta-append 入口：流式每收到一片
// 就调一次（live 渲染），非流式把整段 content / reasoning 当成一个 delta 调一次——
// 对下游 handler 无差别（chat-tab.onChatEvent 对 token 是纯追加语义：
// AgentMarkdown.append(ensureAnswer(), evt.delta)）。渲染动作委托 stream-render.renderDelta，
// 累积动作留在本模块——「流式中间帧与最终帧走同一个 delta-append 函数」在代码上显式成立。
function newAccumulator() {
  return { content: "", reasoning_content: "", toolCalls: {}, finishReason: null, lastUsage: null };
}

// 唯一的 delta-append 入口：累积进 acc（本模块），并委托 stream-render 发渲染事件。
// streaming 多次调用 -> 增量渲染；non-streaming 一次调用 -> 整段渲染。
function feed(acc, onEvent, kind, delta) {
  if (!delta) return;
  if (kind === "reasoning") acc.reasoning_content += delta;
  else acc.content += delta;
  renderDelta(onEvent, kind, delta);
}

// tool_calls 按 index 跨 chunk 拼 arguments 字符串（非纯文本渲染），独立于文本增量，
// 单列处理。非流式路径的 tool_calls 已是完整对象，不经此函数，直接落入 acc.toolCalls。
function appendToolCall(acc, tc) {
  const k = tc.index;
  if (!acc.toolCalls[k]) acc.toolCalls[k] = { id: tc.id, name: (tc.function && tc.function.name) || "", args: "" };
  if (tc.id) acc.toolCalls[k].id = tc.id;
  if (tc.function && tc.function.name) acc.toolCalls[k].name = tc.function.name;
  if (tc.function && tc.function.arguments) acc.toolCalls[k].args += tc.function.arguments;
}

// 共享归一化：把累积结果收敛为统一返回对象，两分支共用。
function finalize(acc) {
  const tool_calls = Object.keys(acc.toolCalls).length
    ? Object.keys(acc.toolCalls).map((k) => ({
        id: acc.toolCalls[k].id,
        type: "function",
        function: { name: acc.toolCalls[k].name, arguments: acc.toolCalls[k].args },
      }))
    : undefined;
  return {
    role: "assistant", content: acc.content, reasoning_content: acc.reasoning_content, tool_calls,
    finish_reason: acc.finishReason,
    usage: acc.lastUsage ? tokenMeter.normalizeUsage(acc.lastUsage) : null,
  };
}

// 非流式：整段读 JSON，把整段 content / reasoning 当成单个 delta 喂给 feed（无 live 层），
// tool_calls 一次性映射，usage 直接取自 json.usage。
async function readNonStreaming(res, acc, onEvent) {
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
  // 整段 content / reasoning 作为单个 delta 发一次（与非流式语义一致）。
  feed(acc, onEvent, "reasoning", msg.reasoning_content || "");
  feed(acc, onEvent, "content", msg.content || "");
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    msg.tool_calls.forEach((tc, k) => {
      acc.toolCalls[k] = {
        id: tc.id,
        name: (tc.function && tc.function.name) || "",
        args: (tc.function && tc.function.arguments) || "",
      };
    });
  }
  if (json.usage) { acc.lastUsage = json.usage; emitUsage(onEvent, json.usage); }
}

// 流式（SSE）：逐片解析，每片 delta 即时 feed（live 渲染）+ 跨 chunk 拼 tool_calls。
async function readStreaming(res, acc, onEvent) {
  let buf = "";
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
        if (choice.finish_reason) acc.finishReason = choice.finish_reason;
        if (o.usage) acc.lastUsage = o.usage;  // 用量通常随最后一个 chunk 下发
        const d = choice.delta || {};
        feed(acc, onEvent, "reasoning", d.reasoning_content || "");  // 增量渲染（live）
        feed(acc, onEvent, "content", d.content || "");              // 增量渲染（live）
        if (d.tool_calls) for (const tc of d.tool_calls) appendToolCall(acc, tc);
      }
    });
    res.on("end", () => { if (acc.lastUsage) emitUsage(onEvent, acc.lastUsage); resolve(); });
    res.on("error", reject);
  });
}

// 单次模型调用（流式或非流式），返回标准化后的 assistant 消息。
// 从 AgentCore._stream 抽出；请求发出委托 model-request.js（issueRequest），
// 流式增量渲染委托 stream-render.js（renderDelta），本模块只做「读响应 + 累积 + 归一化」。
// 流式与非流式共用同一 finalize，流式仅多一层增量渲染（feed 的调用节奏不同），两分支重复已归并。
// 依赖 core 的 reasoningParamFor / effort / model / baseUrl / apiKey（经 issueRequest）。
async function stream(core, { messages, toolDefs, model, onEvent, sessionId, stream = false, maxTokens, baseUrl, apiKey, effort }) {
  onEvent({ type: "model-http-status", state: "on-post" });
  const { res, cap } = await issueRequest(core, { messages, toolDefs, model, maxTokens, baseUrl, apiKey, effort, sessionId, stream });
  onEvent({ type: "model-http-status", state: "on-get", status: cap.status });

  const acc = newAccumulator();
  if (!stream) await readNonStreaming(res, acc, onEvent);
  else await readStreaming(res, acc, onEvent);

  return finalize(acc);
}

module.exports = { stream, emitUsage };
