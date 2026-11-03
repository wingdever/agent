"use strict";

// Tavily-backed web search. This module owns only the provider call and the
// mapping into DSH's normalized search result (answer + sources + truncation);
// argument bounds, multi-query merging, and text formatting live in search.js.

const { DEFAULTS, resolveTavilyConfig } = require("./config");
const { WebToolError } = require("./errors");

const SEARCH_PATH = "/search";
const MISSING_KEY_MESSAGE =
  "web_search is unavailable: missing Tavily API key " +
  "(set web.tavilyApiKey in user/settings.json or TAVILY_API_KEY)";

function buildSearchRequest(query, maxResults, config) {
  return {
    url: config.baseUrl + SEARCH_PATH,
    headers: {
      authorization: "Bearer " + config.apiKey,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": DEFAULTS.userAgent,
    },
    body: {
      query,
      max_results: maxResults,
      search_depth: config.searchDepth,
      include_answer: config.includeAnswer,
      include_raw_content: false,
      include_images: false,
      topic: "general",
    },
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Map a Tavily /search payload into { content?, sources, truncated }. Duplicate
// URLs are collapsed; the provider is asked for maxResults, so overflow only
// happens when a response carries more distinct entries than requested.
function parseTavilyResponse(payload, maxResults) {
  const answer = nonEmptyString(payload && payload.answer);
  const rawResults = payload && Array.isArray(payload.results) ? payload.results : [];
  const seen = new Set();
  const unique = [];

  for (const item of rawResults) {
    if (!item || typeof item !== "object") continue;
    const url = nonEmptyString(item.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const publishedAt = nonEmptyString(item.published_date) || nonEmptyString(item.publishedDate);
    unique.push({
      url,
      ...(nonEmptyString(item.title) !== undefined ? { title: item.title } : {}),
      ...(nonEmptyString(item.content) !== undefined ? { snippet: item.content } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    });
  }

  return {
    ...(answer !== undefined ? { content: answer } : {}),
    sources: unique.slice(0, maxResults),
    truncated: unique.length > maxResults,
  };
}

function extractTavilyError(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const detail = parsed && (parsed.detail ?? parsed.error ?? parsed.message);
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (detail && typeof detail === "object") {
      const nested = detail.error ?? detail.message;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  } catch (_) {
    // Non-JSON error bodies are common for gateway 5xx/429s; fall back to text.
  }
  return raw.slice(0, 300);
}

// Run one Tavily query. `config` and `fetchImpl` are injectable for tests.
async function searchWithTavily(query, { maxResults, config = resolveTavilyConfig(), signal, fetchImpl = fetch } = {}) {
  if (!config.apiKey) throw new WebToolError(MISSING_KEY_MESSAGE);

  const { url, headers, body } = buildSearchRequest(query, maxResults, config);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal && signal.aborted) {
      throw new WebToolError(
        signal.reason && signal.reason.name === "TimeoutError"
          ? "web search timed out"
          : "web search aborted"
      );
    }
    throw new WebToolError("Tavily search request failed: " + String(error));
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = extractTavilyError(await response.text());
    } catch (_) {
      // The HTTP status alone still identifies the failure.
    }
    throw new WebToolError(
      "Tavily API error (HTTP " + response.status + ")" + (detail ? ": " + detail : "")
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal && signal.aborted) {
      throw new WebToolError(
        signal.reason && signal.reason.name === "TimeoutError"
          ? "web search timed out"
          : "web search aborted"
      );
    }
    throw new WebToolError("Tavily returned an unprocessable response body: " + String(error));
  }

  return parseTavilyResponse(payload, maxResults);
}

module.exports = {
  MISSING_KEY_MESSAGE,
  buildSearchRequest,
  parseTavilyResponse,
  searchWithTavily,
};
