"use strict";

// Token metering, ported from DSH's `dsh-token-meter`.
//
// DSH prices the model-visible request as:
//   header (system prompt + tool schemas) + surface (per-message heuristic),
// and anchors the total to the provider's reported usage for the latest
// successful call. While the canonical header is unchanged, the anchored total
// is `usage + (current surface - anchored surface)`; otherwise the whole
// envelope is repriced. Route-specific image pricing is not applicable here:
// this harness sends text-only content, which is exactly the DSH fallback.

const crypto = require("crypto");
const compaction = require("./compaction");

const CHARS_PER_TOKEN = 4;

function estimateHeaderTokens({ system, tools } = {}) {
  let tokens = 0;
  if (system) tokens += Math.ceil(String(system).length / CHARS_PER_TOKEN) + 4;
  for (const tool of tools || []) {
    tokens += Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN);
  }
  return tokens;
}

// Canonical request identity: a routing change (model, system prompt, tool set)
// invalidates the usage anchor and forces a full reprice.
function headerKey({ model, system, tools } = {}) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({ model: model || "", system: system || "", tools: tools || [] }))
    .digest("hex");
}

// Normalize provider usage the same way `_emitUsage` reports it to the UI.
function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const details = raw.prompt_tokens_details || {};
  const cached = typeof raw.cached_tokens === "number"
    ? raw.cached_tokens
    : (typeof details.cached_tokens === "number" ? details.cached_tokens : null);
  const prompt = raw.prompt_tokens != null ? Number(raw.prompt_tokens) : null;
  const completion = raw.completion_tokens != null ? Number(raw.completion_tokens) : null;
  const total = raw.total_tokens != null
    ? Number(raw.total_tokens)
    : (prompt != null && completion != null ? prompt + completion : null);
  return { prompt, completion, total, cached };
}

// Measure request pressure for `messages` under the current header.
// @param anchor - the stored usage anchor, or null.
function measure({ messages, system, tools, model, anchor } = {}) {
  const surfaceTokens = compaction.estimateMessagesTokens(messages || []);
  const headerTokens = estimateHeaderTokens({ system, tools });
  const key = headerKey({ model, system, tools });
  if (anchor && anchor.headerKey === key) {
    const anchoredSurface = Number(anchor.inputTokens) + Number(anchor.assistantTokens);
    const estimatedAnchor = Number(anchor.headerTokens) + anchoredSurface;
    // Trust provider usage only when it is at least the full heuristic price of
    // the anchored request (DSH's conservative anchor rule).
    const useUsage = Number(anchor.usageTotal) >= estimatedAnchor;
    const baseline = useUsage ? Number(anchor.usageTotal) : estimatedAnchor;
    const delta = surfaceTokens - anchoredSurface;
    return {
      total: Math.max(0, baseline + delta),
      surfaceTokens,
      headerTokens,
      headerKey: key,
      baseline: useUsage ? "usage" : "estimated",
    };
  }
  return {
    total: headerTokens + surfaceTokens,
    surfaceTokens,
    headerTokens,
    headerKey: key,
    baseline: "estimated",
  };
}

// Build the anchor recorded after one successful assistant response. The input
// surface is the request's messages (system lives in the header) and the
// assistant price is the response's heuristic output price.
function anchorFrom({ messages, assistant, system, tools, model, usage } = {}) {
  const headerTokens = estimateHeaderTokens({ system, tools });
  const inputTokens = compaction.estimateMessagesTokens(messages || []);
  const assistantTokens = compaction.estimateMessageTokens(assistant || { role: "assistant", content: "" });
  const estimated = headerTokens + inputTokens + assistantTokens;
  const usageTotal = usage && usage.total != null ? Number(usage.total) : estimated;
  return {
    headerKey: headerKey({ model, system, tools }),
    headerTokens,
    inputTokens,
    assistantTokens,
    usageTotal,
  };
}

module.exports = { estimateHeaderTokens, headerKey, normalizeUsage, measure, anchorFrom };
