"use strict";

// Prepare the per-turn injected input. `deps` is { store, skills }.

import { resolveReferences } from "./user-references.js";

async function prepareUserInput(deps, { text, cwd, references, sessionId, persist }) {
  const refs = [];
  const store = deps && deps.store;
  if (Array.isArray(references) && references.length && persist && store) {
    try {
      const refBlock = await resolveReferences(deps, references, sessionId, cwd);
      if (refBlock) refs.push({ role: "user", content: refBlock });
    } catch (e) {
      console.error("[core] resolve references failed:", e.message);
    }
  }
  return { refs };
}

const __exports = { prepareUserInput };
export { prepareUserInput };
export default __exports;
