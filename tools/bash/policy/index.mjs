// Phase 2 policy engine entry point.
//
// Usage (from CJS, e.g. a future run.js integration):
//   const { evaluate, loadPolicy } = await import("../bash/policy/index.mjs");
//   const policy = loadPolicy();            // reads user/bash-policy.json
//   const ir = parseCommand(command);       // from tools/bash/parse
//   const decision = evaluate(ir, policy);  // { overall, commands, ... }
//
// Pure decision function: it never executes commands or touches the UI. The
// caller decides how to act on allow / ask / deny.

export { evaluate } from "./evaluate.mjs";
export { loadPolicy } from "./schema.mjs";
export { decideSimple, maxDecision, baseline } from "./match.mjs";
