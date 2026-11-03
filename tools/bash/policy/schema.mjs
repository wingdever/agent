// Policy file loading, validation, and fail-closed fallback.
//
// Persistence: a standalone JSON file (default user/bash-policy.json), kept
// beside the per-tool user/permissions.json. If the file is missing, malformed,
// or contains no usable rules, we fall back to { default: "ask", rules: [] } so
// a broken security config never widens access.

import fs from "node:fs";
import path from "node:path";

const DECISIONS = new Set(["allow", "ask", "deny"]);
const DEFAULT_FILE = path.join(process.cwd(), "user", "bash-policy.json");

function warn(message) {
  console.error("[bash-policy] " + message);
}

// Validate one rule. Returns a normalized rule or null (ignored).
function normalizeRule(entry) {
  if (!entry || typeof entry !== "object") {
    warn("ignoring non-object rule entry");
    return null;
  }
  const match = entry.match;
  if (!match || typeof match !== "object") {
    warn("ignoring rule without a match object");
    return null;
  }
  if (typeof match.program !== "string" || !match.program) {
    warn("ignoring rule whose match.program is not a non-empty string");
    return null;
  }
  if (match.args !== undefined && !Array.isArray(match.args)) {
    warn("ignoring rule whose match.args is not an array");
    return null;
  }
  if (!DECISIONS.has(entry.decision)) {
    warn('rule for "' + match.program + '" has invalid decision "' + entry.decision + '" (using ask)');
    return null; // drop invalid decision rather than guess
  }
  if (entry.env !== undefined && (typeof entry.env !== "object" || Array.isArray(entry.env))) {
    warn("ignoring rule with invalid env (must be an object)");
    return null;
  }
  return {
    match: {
      program: match.program,
      args: Array.isArray(match.args) ? match.args.map(String) : undefined,
    },
    decision: entry.decision,
    reason: typeof entry.reason === "string" ? entry.reason : undefined,
    env: entry.env,
  };
}

export function loadPolicy(filePath = DEFAULT_FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") warn("cannot read " + filePath + ": " + e.message + " (falling back to ask)");
    return { default: "ask", rules: [], source: null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn("top level must be an object (falling back to ask)");
    return { default: "ask", rules: [], source: filePath };
  }

  let fallback = "ask";
  if (raw.default !== undefined) {
    if (DECISIONS.has(raw.default)) fallback = raw.default;
    else warn('default "' + raw.default + '" is not one of allow/ask/deny (using ask)');
  }

  const rules = [];
  if (!Array.isArray(raw.rules)) {
    warn("rules must be an array (none loaded)");
  } else {
    for (const entry of raw.rules) {
      const r = normalizeRule(entry);
      if (r) rules.push(r);
    }
  }
  return { default: fallback, rules, source: filePath };
}
