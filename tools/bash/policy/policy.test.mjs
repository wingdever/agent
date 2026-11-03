import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../parse/index.mjs";
import { evaluate, loadPolicy, decideSimple, baseline, maxDecision } from "../policy/index.mjs";

// A minimal in-memory policy (no file needed for most tests).
function policyWith(rules, def = "ask") {
  return { default: def, rules, source: null };
}

function decide(src, policy) {
  const ir = parseCommand(src);
  return evaluate(ir, policy);
}

// --- baseline classification -------------------------------------------------
test("baseline: read command allowed, others ask by default", () => {
  assert.equal(baseline("read"), "allow");
  assert.equal(baseline("write"), "ask");
  assert.equal(baseline("network"), "ask");
  assert.equal(baseline("mixed"), "ask");
  assert.equal(baseline("neutral"), "ask");
});

test("read command with no rule -> allow", () => {
  const d = decide("cat file.txt", policyWith([]));
  assert.equal(d.overall, "allow");
  assert.equal(d.commands[0].decision, "allow");
});

// --- program + arg prefix override ------------------------------------------
test("arg-prefix rule overrides write baseline to deny", () => {
  const p = policyWith([{ match: { program: "rm", args: ["-rf", "/"] }, decision: "deny", reason: "no root delete" }]);
  const d = decide("rm -rf /", p);
  assert.equal(d.overall, "deny");
  assert.equal(d.firstDeny.program, "rm");
});

test("user allow rule overrides write baseline", () => {
  const p = policyWith([{ match: { program: "rm", args: ["/tmp/x"] }, decision: "allow" }]);
  const d = decide("rm /tmp/x", p);
  assert.equal(d.overall, "allow");
});

// --- wrapper composite + outer-not-weakened ---------------------------------
test("wrapper composite key: sudo rm matched by sudo rm rule", () => {
  const p = policyWith([{ match: { program: "sudo", args: ["rm"] }, decision: "deny" }]);
  const d = decide("sudo rm -rf /", p);
  assert.equal(d.overall, "deny");
});

test("outer deny not weakened by inner allow", () => {
  const p = policyWith([
    { match: { program: "sudo", args: ["rm"] }, decision: "deny" },
    { match: { program: "rm" }, decision: "allow" },
  ]);
  const d = decide("sudo rm -rf /", p);
  assert.equal(d.overall, "deny");
});

test("inner rm deny not bypassed by sudo (penetration)", () => {
  const p = policyWith([{ match: { program: "rm" }, decision: "deny" }]);
  const d = decide("sudo rm -rf /", p);
  assert.equal(d.overall, "deny");
});

test("sudo ls with no sudo rule penetrates to inner ls:allow -> allow", () => {
  // Outer `sudo` has no rule; penetration reaches inner `ls`, which is allowed.
  const p = policyWith([{ match: { program: "ls" }, decision: "allow" }]);
  const d = decide("sudo ls", p);
  assert.equal(d.overall, "allow");
});

test("sudo with inner ask stays ask (outer does not weaken)", () => {
  // Inner `rm` -> baseline ask; no rm/sudo rule. Outer sudo spec has no rule.
  const d = decide("sudo rm -rf /", policyWith([]));
  assert.equal(d.overall, "ask");
});

// --- aggregation -------------------------------------------------------------
test("pipeline all-allow -> allow", () => {
  const p = policyWith([{ match: { program: "cat" }, decision: "allow" }, { match: { program: "grep" }, decision: "allow" }]);
  const d = decide("cat a | grep x", p);
  assert.equal(d.overall, "allow");
});

test("any deny in compound -> deny", () => {
  const p = policyWith([{ match: { program: "rm", args: ["-rf", "/"] }, decision: "deny" }]);
  const d = decide("cat a && rm -rf /", p);
  assert.equal(d.overall, "deny");
});

test("any ask in compound -> ask (no deny present)", () => {
  const p = policyWith([{ match: { program: "cat" }, decision: "allow" }]);
  const d = decide("cat a || curl http://x", p);
  assert.equal(d.overall, "ask");
});

test("subshell/bracegroup aggregates inner commands", () => {
  const p = policyWith([{ match: { program: "rm", args: ["-rf", "/"] }, decision: "deny" }]);
  const d = decide("( cd /tmp; rm -rf / )", p);
  assert.equal(d.overall, "deny");
});

// --- fail-closed -------------------------------------------------------------
test("unreliable IR never allows", () => {
  // Force an unreliable IR by stubbing: parse something that yields errors is
  // environment-dependent, so instead assert the engine bumps allow->ask when
  // the flag is set.
  const ir = parseCommand("cat a");
  ir.unreliable = true;
  const d = evaluate(ir, policyWith([{ match: { program: "cat" }, decision: "allow" }]));
  assert.equal(d.overall, "ask");
});

test("compound control structure -> at least ask", () => {
  const d = decide("if true; then ls; fi", policyWith([]));
  assert.equal(d.overall, "ask");
  assert.ok(d.commands.some((c) => c.program === "if" && c.decision === "ask"));
});

// --- dynamic ----------------------------------------------------------------
test("dynamic command ($CMD) -> ask by default", () => {
  const d = decide("$CMD arg", policyWith([]));
  assert.equal(d.overall, "ask");
  assert.equal(d.commands[0].dynamic, true);
});

test("dynamic var bound by assignment is concretized and matched", () => {
  // CMD=ls $CMD -l  -> program $CMD bound to ls; rule ls:allow applies.
  const p = policyWith([{ match: { program: "ls" }, decision: "allow" }]);
  const d = decide("CMD=ls $CMD -l", p);
  assert.equal(d.overall, "allow");
});

test("dynamic with env-pattern allow rule degrades to ask (unverifiable)", () => {
  const p = policyWith([
    { match: { program: "curl", args: ["$URL"] }, decision: "allow", env: { URL: "https://internal/*" } },
  ]);
  const d = decide("curl $URL", p);
  // cannot verify $URL at the gate -> ask (fail-closed)
  assert.equal(d.overall, "ask");
});

// --- decision helpers --------------------------------------------------------
test("maxDecision ordering", () => {
  assert.equal(maxDecision("allow", "ask"), "ask");
  assert.equal(maxDecision("ask", "deny"), "deny");
  assert.equal(maxDecision("allow", "deny"), "deny");
  assert.equal(maxDecision("allow", "allow"), "allow");
  assert.equal(maxDecision(null, "ask"), "ask");
});

// --- schema loading fallback -------------------------------------------------
test("loadPolicy returns safe fallback on missing file", () => {
  const p = loadPolicy("/nonexistent/path/bash-policy.json");
  assert.equal(p.default, "ask");
  assert.deepEqual(p.rules, []);
});
