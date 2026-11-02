"use strict";

// Per-tool execution permissions, read from user/permissions.json at the start
// of each chat round. Levels: allow (execute directly), ask (wait for the user),
// deny (refuse without asking). Anything unreadable, malformed, or invalid falls
// back to "ask" so a broken security config never widens access.

const fs = require("fs");
const path = require("path");

const PERMISSIONS_FILE = path.join(__dirname, "..", "user", "permissions.json");
const LEVELS = new Set(["allow", "ask", "deny"]);

function logInvalid(message) {
  console.error("[permissions] " + message);
}

function fallbackPermissions() {
  return { default: "ask", tools: new Map() };
}

// Parse the file into { default, tools: Map<name, level> }. Unknown tool names
// are kept (the tool may be added later); callers only look up visible tools.
// `filePath` is overridable for tests.
function readPermissions(filePath = PERMISSIONS_FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      logInvalid("cannot read " + filePath + ": " + e.message + " (falling back to ask)");
    }
    return fallbackPermissions();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    logInvalid("top level must be an object (falling back to ask)");
    return fallbackPermissions();
  }

  let fallback = "ask";
  if (raw.default !== undefined) {
    if (LEVELS.has(raw.default)) fallback = raw.default;
    else logInvalid('default "' + raw.default + '" is not one of allow/ask/deny (using ask)');
  }

  const tools = new Map();
  if (raw.tools !== undefined && !Array.isArray(raw.tools)) {
    logInvalid("tools must be an array (ignored)");
  }
  for (const entry of Array.isArray(raw.tools) ? raw.tools : []) {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name.trim()) {
      logInvalid("ignoring tool entry without a name");
      continue;
    }
    if (!LEVELS.has(entry.permission)) {
      logInvalid('tool "' + entry.name + '" has invalid permission "' + entry.permission + '" (using ask)');
      tools.set(entry.name, "ask");
      continue;
    }
    tools.set(entry.name, entry.permission);
  }
  return { default: fallback, tools };
}

// Resolve one tool's level; the configured default covers unlisted tools.
function permissionFor(permissions, toolName) {
  if (!permissions || !permissions.tools) return "ask";
  const configured = permissions.tools.get(toolName);
  return configured || permissions.default || "ask";
}

module.exports = { PERMISSIONS_FILE, readPermissions, permissionFor };
