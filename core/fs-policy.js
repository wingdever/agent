"use strict";

// Fine-grained path control for file-writing tools (write / edit).
//
// Sits on top of the per-tool gate in core/permissions.js. A tool-level
// "ask" (the current default for write/edit) can be narrowed or widened by
// path rules: e.g. deny writes under a sensitive dir, or auto-allow writes
// under a scratch/test dir.
//
// Rules live in user/fs-policy.json (a sibling of user/permissions.json),
// shaped as:
//
//   {
//     "rules": [
//       { "path": "docs/**", "permission": "deny" },
//       { "path": "src/**/*.test.js", "permission": "allow" }
//     ]
//   }
//
// Matching: each path pattern is tried against the target both as an absolute
// path glob and as a workspace-relative glob (basename-anchored, so "docs/**"
// matches any file under any ".../docs/"). `deny` always wins (the first
// matching deny refuses); otherwise the first matching rule decides. No rule
// matches -> the tool-level permission from permissions.json is used.
//
// Fail behavior: a missing, malformed, or otherwise invalid policy file is
// ignored entirely, so a broken fine-grained config never quietly widens or
// narrows access -- the per-tool gate stays authoritative.

import fs from "fs";
import path from "path";
import { permissionFor } from "./permissions.js";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __pathDirname } from "node:path";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));


const FS_POLICY_FILE = path.join(__dirname, "..", "user", "fs-policy.json");
const LEVELS = new Set(["allow", "ask", "deny"]);

function logInvalid(message) {
  console.error("[fs-policy] " + message);
}

function fallbackPolicy() {
  return { rules: [] };
}

// Parse the file into { rules: Array<{ pattern, permission }> }. Invalid
// entries are dropped with a warning; `filePath` is overridable for tests.
function readFsPolicy(filePath = FS_POLICY_FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      logInvalid("cannot read " + filePath + ": " + e.message + " (ignoring fine-grained rules)");
    }
    return fallbackPolicy();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    logInvalid("top level must be an object (ignoring fine-grained rules)");
    return fallbackPolicy();
  }
  if (!Array.isArray(raw.rules)) {
    if (raw.rules !== undefined) logInvalid("rules must be an array (ignoring fine-grained rules)");
    return fallbackPolicy();
  }

  const rules = [];
  for (const entry of raw.rules) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !entry.path.trim()) {
      logInvalid("ignoring fs-policy rule without a path");
      continue;
    }
    if (!LEVELS.has(entry.permission)) {
      logInvalid('fs-policy rule "' + entry.path + '" has invalid permission "' + entry.permission + '" (ignored)');
      continue;
    }
    rules.push({ pattern: entry.path, permission: entry.permission });
  }
  return { rules };
}

// Glob match where a pattern without a leading slash is matched against the
// tail of the target path, so "docs/**" matches "/abs/workspace/docs/x.md"
// regardless of the workspace root. Absolute patterns match the full path.
function matches(pattern, target) {
  const norm = pattern.replace(/\\/g, "/");
  const normTarget = target.replace(/\\/g, "/");
  if (norm.startsWith("/")) {
    // Absolute pattern: full-path glob.
    return globMatch(normTarget, norm);
  }
  // Relative pattern: anchor at any path segment boundary.
  const segments = norm.split("/").filter(Boolean);
  const tail = segments.join("/");
  if (normTarget === tail) return true;
  // Match when the pattern appears as a path segment suffix:
  // ".../<pattern>" or ".../<pattern>/...".
  return globMatch(normTarget, "**/" + tail) || globMatch(normTarget, "**/" + tail + "/**");
}

// Minimal glob matcher supporting ** (any depth), * (one segment), ? (one
// char). Enough for path rules; not a full glob implementation.
function globMatch(text, pattern) {
  const re = globToRegExp(pattern);
  return re.test(text);
}

function globToRegExp(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** : match across any number of segments (including zero).
        let j = i + 2;
        if (pattern[j] === "/") j += 1;
        re += "(?:.*)";
        i = j;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
    i += 1;
  }
  return new RegExp("^" + re + "$");
}

// Resolve the effective permission for a file-writing call.
// - permissions: output of readPermissions (per-tool gate)
// - fsPolicy: output of readFsPolicy (fine-grained rules)
// - toolName: "write" | "edit"
// - filePath: raw file_path argument from the tool call
// - cwd: workspace root, used as the relative-pattern base
//
// Returns one of allow/ask/deny. Deny rules win; otherwise the first matching
// rule decides; no match falls back to the per-tool permission.
function resolveFsPermission(permissions, fsPolicy, toolName, filePath, cwd) {
  if (!fsPolicy || !Array.isArray(fsPolicy.rules) || fsPolicy.rules.length === 0) {
    return permissionForTool(permissions, toolName);
  }
  const rawPath = typeof filePath === "string" ? filePath : "";
  if (!rawPath.trim()) return permissionForTool(permissions, toolName);

  const absolute = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(cwd || process.cwd(), rawPath);

  // Two passes: a deny anywhere vetoes any allow, so scan denies first.
  let firstMatch = null;
  for (const rule of fsPolicy.rules) {
    if (rule.permission === "deny" && matches(rule.pattern, absolute)) return "deny";
    if (firstMatch === null && matches(rule.pattern, absolute)) firstMatch = rule.permission;
  }
  if (firstMatch !== null) return firstMatch; // allow (or ask) overrides the tool-level default
  return permissionForTool(permissions, toolName);
}

// Resolve a multi-path tool. A deny on any path wins; otherwise the most
// restrictive result (ask > allow) is used, and a path with no rule keeps the
// tool-level fallback.
function resolveFsPermissionForPaths(permissions, fsPolicy, toolName, filePaths, cwd) {
  const paths = Array.isArray(filePaths) ? filePaths.filter((p) => typeof p === "string" && p.trim()) : [];
  if (paths.length === 0) return permissionForTool(permissions, toolName);
  let anyAsk = false;
  let anyAllow = false;
  for (const filePath of paths) {
    const level = resolveFsPermission(permissions, fsPolicy, toolName, filePath, cwd);
    if (level === "deny") return "deny";
    if (level === "ask") anyAsk = true;
    if (level === "allow") anyAllow = true;
  }
  if (anyAsk) return "ask";
  if (anyAllow) return "allow";
  return permissionForTool(permissions, toolName);
}

// Paths a filesystem-writing tool touches. apply_patch embeds its paths in the
// patch text, so the extractor is deliberately conservative: every Add/Update/
// Delete/Move target is checked against the policy.
function fsPathsForTool(toolName, args = {}) {
  if (!args || typeof args !== "object") return [];
  if (toolName === "write" || toolName === "edit" || toolName === "read_image") {
    return [args.file_path];
  }
  if (toolName === "str_replace_editor") return [args.path];
  if (toolName === "apply_patch" && typeof args.input === "string") {
    const found = [];
    const re = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm;
    let match;
    while ((match = re.exec(args.input)) !== null) found.push(match[1].trim());
    const moveRe = /^\*\*\* Move to:\s*(.+)$/gm;
    while ((match = moveRe.exec(args.input)) !== null) found.push(match[1].trim());
    return found;
  }
  return [];
}

function permissionForTool(permissions, toolName) {
  return permissionFor(permissions, toolName);
}

export default {
  FS_POLICY_FILE,
  readFsPolicy,
  resolveFsPermission,
  resolveFsPermissionForPaths,
  fsPathsForTool,
  // exported for tests
  _matches: matches,
  _globToRegExp: globToRegExp,
};
export {
  FS_POLICY_FILE,
  readFsPolicy,
  resolveFsPermission,
  resolveFsPermissionForPaths,
  fsPathsForTool,
};
