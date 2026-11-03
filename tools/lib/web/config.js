"use strict";

// Configuration for the web tools. Only the Tavily credential/provider knobs
// are user-configurable: counts, timeouts, and transport limits stay at DSH's
// defaults so the model-facing descriptions ("1-4 queries", 8 sources) and the
// rendered text keep matching the behavior the model is told about.

const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "..", "..", "..", "user", "settings.json");

const DEFAULTS = {
  maxResults: 8,
  maxQueries: 4,
  searchTimeoutMs: 30000,
  fetchTimeoutMs: 30000,
  fetchMaxResponseBytes: 5 * 1000 * 1000,
  fetchMaxBodyChars: 100000,
  fetchMaxOutputChars: 200000,
  fetchMaxRedirects: 5,
  fetchMaxUrlLength: 2048,
  userAgent: "agent-ui/0.1.0",
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Read `web` from user/settings.json. A missing or malformed file means "no
// overrides", never a hard failure: both tools still load and report their own
// configuration errors at execution time.
function readWebSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed.web === "object" && parsed.web !== null ? parsed.web : {};
  } catch (_) {
    return {};
  }
}

// Resolve the Tavily client settings. `web.tavilyApiKey` is the documented
// location; TAVILY_API_KEY is the CI/Electron-friendly fallback.
function resolveTavilyConfig(web = readWebSettings()) {
  const tavily = web && typeof web.tavily === "object" && web.tavily !== null ? web.tavily : {};
  const apiKey =
    nonEmptyString(web.tavilyApiKey) ||
    nonEmptyString(tavily.apiKey) ||
    nonEmptyString(process.env.TAVILY_API_KEY) ||
    "";
  return {
    apiKey,
    baseUrl: (nonEmptyString(tavily.baseUrl) || "https://api.tavily.com").replace(/\/+$/, ""),
    searchDepth: tavily.searchDepth === "advanced" ? "advanced" : "basic",
    includeAnswer: tavily.includeAnswer !== false,
  };
}

module.exports = { DEFAULTS, SETTINGS_FILE, readWebSettings, resolveTavilyConfig };
