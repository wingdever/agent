"use strict";

// Shared permission gate for the bash tool providers. Both the one-shot and
// persistent providers must enforce the same policy before a shell is touched.

let _enginePromise = null;

function loadEngine() {
  if (!_enginePromise) {
    _enginePromise = (async () => {
      const policy = await import("../bash/policy/index.js");
      const parse = await import("../bash/parse/index.js");
      return { policy, parse };
    })();
  }
  return _enginePromise;
}

function blockedVerdict(reason) {
  return {
    verdict: "deny",
    text: "[bash policy] command blocked: " + reason,
    isError: true,
    meta: { kind: "policy-blocked" },
  };
}

// Returns a verdict object describing whether the command may run:
//   { verdict: "allow" }                                   -> proceed
//   { verdict: "deny", ...blockedResult }                  -> refuse, no approval
//   { verdict: "ask", ...blockedResult, decision }         -> needs user approval
// Never throws to the caller.
export async function gateBashCommand(command) {
  let engine;
  try {
    engine = await loadEngine();
  } catch (e) {
    return blockedVerdict("policy engine unavailable (" + (e.message || e) + ")");
  }
  let decision;
  try {
    const ir = engine.parse.parseCommand(command);
    const policy = engine.policy.loadPolicy();
    // Opt-in: the gate only enforces when a policy file is present. With no
    // configured policy the tool runs unconstrained (dev default); once
    // user/bash-policy.json exists, the fail-closed "default ask" applies.
    if (policy.source === null) return { verdict: "allow" };
    decision = engine.policy.evaluate(ir, policy);
  } catch (e) {
    return blockedVerdict("unable to analyze command (" + (e.message || e) + ")");
  }
  if (decision.overall === "allow") return { verdict: "allow" };

  const blocked = decision.commands.filter((c) => c.decision !== "allow");
  const lines = blocked.map((c) => "  - " + (c.program || "?") + ": " + c.decision + " (" + c.reason + ")");
  if (decision.overall === "deny") {
    return {
      verdict: "deny",
      decision,
      text: "[bash policy] command denied by policy\n" + lines.join("\n"),
      isError: true,
      meta: { kind: "policy-blocked", decision },
    };
  }
  return {
    verdict: "ask",
    decision,
    text: "[bash policy] command requires approval\n" + lines.join("\n"),
    isError: true,
    meta: { kind: "policy-blocked", decision },
  };
}

export default { gateBashCommand };
