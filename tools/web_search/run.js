"use strict";

// web_search: query Tavily, merge up to four queries, and render DSH's search
// text. The query cap is baked into the registry description; keep them in
// sync if DEFAULTS.maxQueries ever changes.

const { DEFAULTS, resolveTavilyConfig } = require("../lib/web/config");
const {
  formatSearchOutput,
  parseSearchArgs,
  runSearchQueries,
} = require("../lib/web/search");

module.exports = {
  async run(args = {}, exec = {}) {
    const queries = parseSearchArgs(args, DEFAULTS.maxQueries);
    const config = resolveTavilyConfig();

    const timeout = AbortSignal.timeout(DEFAULTS.searchTimeoutMs);
    const signal = exec.signal ? AbortSignal.any([exec.signal, timeout]) : timeout;

    const result = await runSearchQueries(
      queries,
      DEFAULTS.maxResults,
      { config },
      signal
    );

    return {
      text: formatSearchOutput(result),
      meta: {
        kind: "web",
        operation: "search",
        queries,
        sources: result.sources,
        truncated: result.truncated,
        ...(result.content !== undefined ? { answer: result.content } : {}),
      },
    };
  },
};
