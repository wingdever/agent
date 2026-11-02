"use strict";

// Auto-translation for the English-immersion chat mode.
//
// The model only ever sees English: a Chinese user turn is translated to
// English before the request, and the model's English answer is translated back
// to Chinese for display. Translation is a side channel: it never changes the
// conversation history that is persisted or replayed.
//
// Provider defaults target bilibili's Index-Translate (OpenAI-compatible,
// no API key). Everything can be overridden from user/settings.json:
//
//   "translate": {
//     "enabled": true,
//     "baseUrl": "https://index-translate.bilibili.com/v1",
//     "model": "Index-Translate-35B-A3B",
//     "apiKey": "",
//     "params": { "temperature": 0, "chat_template_kwargs": { "enable_thinking": false } },
//     "timeoutMs": 30000
//   }

const { postChatCompletions, trackCapture } = require("./network/http/client");

const DEFAULT_CONFIG = {
  enabled: true,
  baseUrl: "https://index-translate.bilibili.com/v1",
  model: "Index-Translate-35B-A3B",
  apiKey: "",
  params: {
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  },
  // Input translation blocks the send, so fail fast; output translation keeps
  // the answer on screen and may take longer.
  inputTimeoutMs: 20000,
  outputTimeoutMs: 30000,
  timeoutMs: 30000,
};

// Han characters: CJK Unified Ideographs, Extension A, compatibility ideographs.
const HAN_SOURCE = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF";
const HAN_RE = new RegExp("[" + HAN_SOURCE + "]");

const PROMPTS = {
  en: "请将以下文本翻译为英语，直接输出翻译结果；如果原文已经是英语，请原样输出。保留 Markdown 格式、代码块、行内代码、URL、文件路径、命令和专有名词原样不变。\n\n",
  zh: "请将以下文本翻译为中文，直接输出翻译结果；如果原文已经是中文，请原样输出。保留 Markdown 格式、代码块、行内代码、URL、文件路径、命令和专有名词原样不变。\n\n",
};

function hasHan(text) {
  return typeof text === "string" && HAN_RE.test(text);
}

// Prose outside fenced/inline code and URLs. A pure code block or shell snippet
// has nothing to translate, so it is left alone.
function hasProse(text) {
  const stripped = String(text == null ? "" : text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  return /[A-Za-z]/.test(stripped);
}

function resolveConfig(settings) {
  const raw = settings && typeof settings.translate === "object" && settings.translate
    ? settings.translate
    : {};
  const params = Object.assign(
    {},
    DEFAULT_CONFIG.params,
    raw.params && typeof raw.params === "object" ? raw.params : {}
  );
  const config = Object.assign({}, DEFAULT_CONFIG, raw, { params });
  config.enabled = raw.enabled !== false;
  config.baseUrl = String(config.baseUrl || DEFAULT_CONFIG.baseUrl);
  config.model = String(config.model || DEFAULT_CONFIG.model);
  config.apiKey = config.apiKey == null ? "" : String(config.apiKey);
  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // A shared timeoutMs (if the user sets one) is the fallback for both
  // directions; otherwise the direction-specific defaults apply.
  const sharedTimeout = positive(raw.timeoutMs, null);
  config.timeoutMs = sharedTimeout == null ? DEFAULT_CONFIG.timeoutMs : sharedTimeout;
  config.inputTimeoutMs = positive(raw.inputTimeoutMs, sharedTimeout == null ? DEFAULT_CONFIG.inputTimeoutMs : sharedTimeout);
  config.outputTimeoutMs = positive(raw.outputTimeoutMs, sharedTimeout == null ? DEFAULT_CONFIG.outputTimeoutMs : sharedTimeout);
  return config;
}

function shouldTranslateUser(text, config) {
  return !!config.enabled && typeof text === "string" && text.trim().length > 0 && hasHan(text);
}

// The answer is always translated to Chinese when it contains prose. English
// answers can legitimately contain many Chinese characters (quotes, code
// comments, names), so a Han count threshold would skip the translation exactly
// when it is needed. Pure code/command answers are left alone: there is no
// prose to translate, and asking the translator to repaint a code block only
// risks stripping its fences.
function shouldTranslateAssistant(text, config) {
  if (!config.enabled) return false;
  if (typeof text !== "string" || !text.trim()) return false;
  return hasProse(text);
}

function cleanTranslation(text) {
  let out = String(text == null ? "" : text).trim();
  out = out.replace(/^(?:翻译|译文|英文翻译|中文翻译|英文|中文|Translation|English|Chinese)\s*[:：]\s*/i, "");
  return out.trim();
}

function buildPayload(text, target, config) {
  const maxTokens = Math.min(8192, Math.max(1024, Math.ceil(text.length * 2)));
  return Object.assign({}, config.params, {
    model: config.model,
    messages: [{ role: "user", content: PROMPTS[target] + text }],
    stream: false,
    max_tokens: maxTokens,
  });
}

function readJsonBody(res) {
  return new Promise((resolve, reject) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => resolve(raw));
    res.on("error", reject);
  });
}

function isRetriable(error) {
  const message = String((error && error.message) || error || "");
  if (/HTTP (?:429|5\d\d)\b/.test(message)) return true;
  // A socket timeout is usually a hung service; retrying it doubles the
  // blocking time for input translation, so it is not retried.
  if (/timeout/i.test(message)) return false;
  return /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|aborted/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Translate one block of text. Resolves to the translated string; throws when
// both attempts fail. `target` is the language of the result ("en" or "zh").
async function translateText({ text, target, config, sessionId, timeoutMs } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("empty text");
  if (target !== "en" && target !== "zh") throw new Error("unknown translation target: " + target);
  const cfg = config || DEFAULT_CONFIG;
  const payload = buildPayload(text, target, cfg);
  const direction = target === "en" ? "zh->en" : "en->zh";
  const effectiveTimeout = timeoutMs || cfg.timeoutMs;

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = Date.now();
    try {
      const { stream: res, cap } = await postChatCompletions({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        payload,
        sessionId,
        timeoutMs: effectiveTimeout,
      });
      trackCapture(res, cap);
      const raw = await readJsonBody(res);
      let json;
      try {
        json = JSON.parse(raw);
      } catch (_) {
        throw new Error("bad translation response: " + raw.slice(0, 200));
      }
      const choice = (json.choices && json.choices[0]) || {};
      const message = choice.message || {};
      const content = typeof message.content === "string" ? message.content : "";
      if (choice.finish_reason === "length") throw new Error("translation truncated (finish_reason=length)");
      const translated = cleanTranslation(content);
      if (!translated) throw new Error("empty translation");
      // A pure code answer legitimately has no Chinese; a prose answer must.
      if (target === "zh" && hasProse(text) && !hasHan(translated)) {
        throw new Error("translation output is not Chinese");
      }
      console.log("[translate] " + direction + " chars=" + text.length + " ms=" + (Date.now() - startedAt) + " ok");
      return translated;
    } catch (error) {
      lastError = error;
      const willRetry = attempt === 0 && isRetriable(error);
      console.warn("[translate] " + direction + " chars=" + text.length + " attempt=" + (attempt + 1) +
        " ms=" + (Date.now() - startedAt) + " failed: " + String((error && error.message) || error) +
        (willRetry ? " (retrying)" : ""));
      if (!willRetry) break;
      await sleep(300);
    }
  }
  throw lastError || new Error("translation failed");
}

module.exports = {
  DEFAULT_CONFIG,
  buildPayload,
  cleanTranslation,
  hasHan,
  hasProse,
  resolveConfig,
  shouldTranslateAssistant,
  shouldTranslateUser,
  translateText,
};
