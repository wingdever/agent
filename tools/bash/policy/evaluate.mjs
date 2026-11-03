// Evaluation layer: walk the IR, decide every simple command, aggregate the
// compound structure, and emit a Decision. Pure function; does not execute.
//
// Aggregation (docs/tool/bash.md §(3), Claude Code-style):
//   any deny  -> overall deny (short-circuit; record first deny)
//   any ask   -> overall ask
//   all allow -> overall allow
// Fail-closed extras:
//   - unreliased IR (unbash reported errors) -> overall is at least ask
//   - compound control structures (if/for/while/...) -> at least ask

import { decideSimple, maxDecision } from "./match.mjs";

const RANK = { allow: 0, ask: 1, deny: 2 };

// Decide one node; returns { decision, commands } where commands is the flat
// list of per-simple-command records contributed by this node.
function evalNode(node) {
  switch (node.kind) {
    case "command": {
      const { decision, reason } = decideSimple(node, POLICY);
      return {
        decision,
        commands: [
          {
            program: node.program,
            raw: node.raw,
            decision,
            reason,
            dynamic: node.dynamic,
            range: node.range,
          },
        ],
      };
    }
    case "pipeline":
    case "andor": {
      let decision = "allow";
      const commands = [];
      for (const child of node.commands) {
        const r = evalNode(child);
        decision = maxDecision(decision, r.decision);
        commands.push(...r.commands);
      }
      return { decision, commands };
    }
    case "subshell":
    case "bracegroup": {
      let decision = "allow";
      const commands = [];
      for (const stmt of node.body) {
        const r = evalNode(stmt.node);
        decision = maxDecision(decision, r.decision);
        commands.push(...r.commands);
      }
      return { decision, commands };
    }
    case "redirect": {
      // the redirect wrapper contributes its own redirects only as context;
      // the decision is the inner command's.
      return evalNode(node.command);
    }
    case "compound": {
      // not deeply analyzed -> at least ask
      return {
        decision: "ask",
        commands: [
          {
            program: node.compoundType,
            raw: node.summary,
            decision: "ask",
            reason: "compound control structure is not statically analyzed (fail-closed)",
            dynamic: true,
            range: node.range,
          },
        ],
      };
    }
    default:
      return { decision: "ask", commands: [] };
  }
}

// Injected per evaluate() call to avoid threading policy through every frame.
let POLICY = { default: "ask", rules: [] };

export function evaluate(ir, policy) {
  POLICY = policy || { default: "ask", rules: [] };
  let overall = "allow";
  const commands = [];
  let firstDeny = null;

  for (const stmt of ir.statements) {
    const r = evalNode(stmt.node);
    overall = maxDecision(overall, r.decision);
    commands.push(...r.commands);
  }

  // Fail-closed: a malformed / partial parse must never be silently allowed.
  if (ir.unreliable && overall === "allow") overall = "ask";

  if (overall === "deny") {
    firstDeny = commands.find((c) => c.decision === "deny") || null;
  }

  // Normalize: default fallback for anything unexpectedly unset.
  if (!overall) overall = policy && policy.default ? policy.default : "ask";

  return {
    overall,
    commands,
    firstDeny,
    requiresApproval: overall === "ask",
    blocked: overall === "deny",
  };
}
