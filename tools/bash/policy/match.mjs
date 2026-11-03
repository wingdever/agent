// Matching layer: turns a SimpleCommand IR into a single allow/ask/deny decision.
//
// Design (per docs/tool/bash-policy-plan.md, confirmed decisions):
//  - Candidate match specs (most specific first): base {program, argv}, then for
//    each wrapper: the outer-composite {wrapper.program, wrapper.args} AND the
//    penetrated inner {innerProgram, innerArgs}. This prevents a `rm:deny` rule
//    from being bypassed by `sudo`, while still letting `sudo rm:deny` take
//    priority over an inner `rm:allow` (outer deny/ask is not weakened).
//  - Among all matching rules, the most restrictive decision wins (deny>ask>allow).
//  - If no rule matches, the IR read/write classification provides a baseline
//    (read -> allow, everything else -> ask). User rules override the baseline.
//  - Dynamic commands: attempt to bind $VAR parts from literal assignments /
//    stripped env in the same command; bound parts become concrete and match
//    normally. Unbound dynamic parts cannot be verified at the gate, so an
//    `allow` rule with an `env` constraint degrades to `ask` (fail-closed).

const RANK = { allow: 0, ask: 1, deny: 2 };

export function maxDecision(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

// --- candidate specs ---------------------------------------------------------
function buildSpecs(simple) {
  const specs = [];
  if (simple.program !== null) {
    specs.push({ program: simple.program, args: simple.argv, source: "base" });
  } else if (simple.programRaw && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(simple.programRaw)) {
    specs.push({ program: simple.programRaw, args: simple.argv, source: "base-dynamic" });
  }

  for (const w of simple.wrappers || []) {
    const wargs = w.args || [];
    // outer composite key (e.g. sudo + inner words)
    specs.push({ program: w.program, args: wargs, source: "wrapper-outer:" + w.type });
    // penetrated inner command
    if (wargs.length > 0) {
      specs.push({ program: wargs[0], args: wargs.slice(1), source: "wrapper-inner:" + w.type });
    }
  }
  return specs;
}

// --- argv prefix match -------------------------------------------------------
// A rule matches a spec when program equals and every rule arg equals the
// corresponding spec arg (prefix match; spec may carry extra trailing args).
function specMatches(spec, rule) {
  if (spec.program !== rule.match.program) return false;
  const rargs = rule.match.args;
  if (!rargs) return true; // program-only rule
  if (rargs.length > spec.args.length) return false;
  for (let i = 0; i < rargs.length; i++) {
    if (rargs[i] !== spec.args[i]) return false;
  }
  return true;
}

// --- classification baseline -------------------------------------------------
export function baseline(readWrite) {
  return readWrite === "read" ? "allow" : "ask";
}

// --- dynamic concretization --------------------------------------------------
// Bind pure $VAR args / program from literal assignments present in the command.
// Returns { specs, concrete } where concrete=true means no dynamic part remains.
function concretize(simple) {
  const bindings = {};
  for (const a of simple.assignmentPrefix || []) bindings[a.name] = a.value;
  for (const e of simple.envStripped || []) bindings[e.name] = e.value;

  const isVar = (s) => typeof s === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  const bound = (s) => (isVar(s) && bindings[s.slice(1)] !== undefined ? bindings[s.slice(1)] : null);

  let concrete = true;

  const program = (() => {
    if (simple.program !== null) return simple.program;
    if (simple.programRaw) {
      const b = bound(simple.programRaw);
      if (b !== null) return b;
      concrete = false;
      return simple.programRaw; // leave as $VAR, will not match literal rules
    }
    return null;
  })();

  const argv = simple.argv.map((a) => {
    const b = bound(a);
    if (b !== null) return b;
    if (isVar(a)) {
      concrete = false;
      return a;
    }
    return a;
  });

  const specs = [];
  if (program !== null) specs.push({ program, args: argv, source: "concrete" });
  for (const w of simple.wrappers || []) {
    const wargs = (w.args || []).map((a) => {
      const b = bound(a);
      if (b !== null) return b;
      if (isVar(a)) {
        concrete = false;
        return a;
      }
      return a;
    });
    specs.push({ program: w.program, args: wargs, source: "wrapper-outer:" + w.type });
    if (wargs.length > 0) specs.push({ program: wargs[0], args: wargs.slice(1), source: "wrapper-inner:" + w.type });
  }
  return { specs, concrete };
}

// --- single command decision ------------------------------------------------
// Returns { decision, reason, matchedRule }.
export function decideSimple(simple, policy) {
  const isDynamic = Boolean(simple.dynamic);
  let specs;
  let concrete = !isDynamic;

  if (isDynamic) {
    const c = concretize(simple);
    specs = c.specs;
    concrete = c.concrete;
  } else {
    specs = buildSpecs(simple);
  }

  let decision = null;
  let matchedRule = null;

  for (const spec of specs) {
    for (const rule of policy.rules) {
      if (!specMatches(spec, rule)) continue;
      // An `env`-constrained rule cannot be confirmed at the gate unless the
      // command was fully concretized; degrade allow -> ask (fail-closed).
      let ruleDecision = rule.decision;
      let reason = rule.reason;
      if (rule.env && !concrete) {
        if (ruleDecision === "allow") ruleDecision = "ask";
        reason = reason || "dynamic var matches an allowed pattern but value is unverified at the gate";
      }
      if (decision === null || RANK[ruleDecision] > RANK[decision]) {
        decision = ruleDecision;
        matchedRule = rule;
        // keep a reason even if the rule had none
        if (!reason) {
          reason =
            spec.source === "base" || spec.source === "concrete"
              ? "matched rule for " + spec.program
              : "matched rule via " + spec.source;
        }
      }
    }
  }

  if (decision !== null) {
    return { decision, reason: matchedRule?.reason || "matched policy rule", matchedRule };
  }

  // No user rule matched.
  if (isDynamic && !concrete) {
    return {
      decision: "ask",
      reason: "dynamic command (variable/interpreter/substitution) has no matching rule",
      matchedRule: null,
    };
  }
  const base = baseline(simple.readWrite);
  return {
    decision: base,
    reason: base === "allow" ? "baseline: read-only command" : "baseline: no rule matched (default ask)",
    matchedRule: null,
  };
}
