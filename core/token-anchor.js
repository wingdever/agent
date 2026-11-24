"use strict";
import tokenMeter from "./token-meter.js";

// Record the DSH usage anchor after one successful response.
// Explicit deps: { store }.
async function recordTokenAnchor({ store }, { sessionId, model, system, tools, messages, assistant, usage }) {
  if (!store || !sessionId) return null;
  try {
    const anchor = tokenMeter.anchorFrom({ messages, assistant, system, tools, model, usage });
    return await store.run("tokenAnchor.save", {
      session_id: sessionId,
      header_key: anchor.headerKey,
      header_tokens: anchor.headerTokens,
      input_tokens: anchor.inputTokens,
      assistant_tokens: anchor.assistantTokens,
      usage_total: anchor.usageTotal,
    });
  } catch (error) {
    console.warn("[token-meter] anchor save failed:", (error && error.message) || error);
    return null;
  }
}

const __exports = { recordTokenAnchor };
export { recordTokenAnchor };
export default __exports;
