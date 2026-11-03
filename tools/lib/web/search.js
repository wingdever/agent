"use strict";

// Model-facing web_search orchestration: argument bounds, concurrent query
// merging, and the exact DSH result text. The provider call itself lives in
// tavily.js; this module never touches the network, so formatting and merge
// behavior are unit-testable offline.

const { DEFAULTS } = require("./config");
const { searchWithTavily } = require("./tavily");
const { EXTERNAL_WEB_CONTENT_NOTICE } = require("./trust");

// Validate constraints the JSON schema cannot express: a non-empty query list,
// only non-blank strings, and the deployment's query-count bound. Exact
// duplicates collapse after the bound check.
function parseSearchArgs(args, maxQueries = DEFAULTS.maxQueries) {
  const queries = args && args.queries;
  if (!Array.isArray(queries)) throw new Error("queries must be an array");
  if (queries.length === 0) throw new Error("queries must contain at least one query");
  if (queries.length > maxQueries) {
    const noun = maxQueries === 1 ? "query" : "queries";
    throw new Error("queries must contain at most " + maxQueries + " " + noun);
  }
  if (queries.some((query) => typeof query !== "string" || query.trim().length === 0)) {
    throw new Error("each query must be a non-empty string");
  }
  return [...new Set(queries)];
}

// Display label for a source: its title, else its hostname.
function sourceLabel(url, title) {
  if (title !== undefined && title.length > 0) return title;
  try {
    return new URL(url).hostname;
  } catch (_) {
    return url;
  }
}

// Format a search result as one model-facing text block: the untrusted-content
// notice, the provider answer (when any), a markdown source list with snippet
// and date metadata, a refine-the-query note when truncated, and the standing
// cite-your-sources instruction.
function formatSearchOutput(result) {
  const parts = [EXTERNAL_WEB_CONTENT_NOTICE];
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content);

  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title);
      const meta = [];
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet);
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) {
        meta.push("(" + source.publishedAt + ")");
      }
      const suffix = meta.length > 0 ? " — " + meta.join(" ") : "";
      return "- [" + label + "](" + source.url + ")" + suffix;
    });
    parts.push("Sources:\n" + lines.join("\n"));
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push("No results found.");
  }

  if (result.truncated) {
    parts.push("(Showing the first " + result.sources.length + " sources. Refine the query for more.)");
  }
  parts.push("Cite the relevant URLs above as markdown links in your answer.");
  return parts.join("\n\n");
}

// Merge per-query results into one deduplicated, round-robin, capped result.
function mergeSearchResults(queries, results, maxResults) {
  const seen = new Set();
  const sources = [];
  let sourceRanks = 0;
  for (const result of results) sourceRanks = Math.max(sourceRanks, result.sources.length);

  let droppedSource = false;
  let capped = false;
  for (let rank = 0; rank < sourceRanks && !capped; rank += 1) {
    for (const result of results) {
      const source = result.sources[rank];
      if (source !== undefined && !seen.has(source.url)) {
        seen.add(source.url);
        if (sources.length === maxResults) {
          droppedSource = true;
          capped = true;
          break;
        }
        sources.push(source);
      }
    }
  }

  const contents = results.flatMap((result, index) => {
    if (result.content === undefined || result.content.length === 0) return [];
    return ["### " + queries[index] + "\n\n" + result.content];
  });

  return {
    ...(contents.length > 0 ? { content: contents.join("\n\n") } : {}),
    sources,
    truncated: results.some((result) => result.truncated) || droppedSource,
  };
}

// Run one or more searches. A single query keeps the provider's exact result;
// multiple queries run concurrently and are merged into one capped result. A
// failed search aborts its siblings, and the first failure is rethrown after
// every search settles.
async function runSearchQueries(queries, maxResults, options, signal) {
  const search = options.searchFn || searchWithTavily;
  const searchOptions = { maxResults, config: options.config, signal };

  if (queries.length === 1) return search(queries[0], searchOptions);

  const controller = new AbortController();
  const batchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let firstFailure;
  const results = [];
  const searches = queries.map(async (query, index) => {
    try {
      results[index] = await search(query, { ...searchOptions, signal: batchSignal });
    } catch (error) {
      if (firstFailure === undefined) firstFailure = { error };
      controller.abort(error);
      throw error;
    }
  });

  await Promise.allSettled(searches);
  if (firstFailure !== undefined) throw firstFailure.error;
  return mergeSearchResults(queries, results, maxResults);
}

module.exports = {
  formatSearchOutput,
  mergeSearchResults,
  parseSearchArgs,
  runSearchQueries,
  sourceLabel,
};
