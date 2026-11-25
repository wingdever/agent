"use strict";

// Read and validate user/lsp.json. One enabled entry becomes one stdio language
// server provider. Invalid entries are skipped with a log line, never by
// aborting core startup: an empty table is a valid "no LSP configured" state.

import config from "./../config/index.js";
import { PROJECT_ROOT } from "./../../lib/paths/index.js";

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TIMEOUT_MS = 600000;

// Defaults cover the common installed servers. A provider may override any
// extension through `languageIds`; unknown extensions still work as long as the
// provider declares them and gives an explicit languageId.
const LANGUAGE_BY_EXTENSION = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".json": "json",
  ".jsonc": "jsonc",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".sh": "shellscript",
  ".lua": "lua",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".swift": "swift",
  ".zig": "zig",
};

function log(logger, level, message) {
  if (logger && typeof logger[level] === "function") logger[level](message);
}

function expand(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    if (name === "PROJECT_ROOT") return PROJECT_ROOT;
    const fromEnv = process.env[name];
    return fromEnv === undefined ? whole : fromEnv;
  });
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeExtensions(entry) {
  const declared = Array.isArray(entry.extensions)
    ? entry.extensions
    : Object.keys(objectOrEmpty(entry.languageIds));
  const out = [];
  for (const value of declared) {
    if (typeof value !== "string") continue;
    let ext = value.trim().toLowerCase();
    if (!ext) continue;
    if (!ext.startsWith(".")) ext = "." + ext;
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

function normalizeLanguageIds(entry, extensions) {
  const ids = {};
  for (const [rawExt, rawId] of Object.entries(objectOrEmpty(entry.languageIds))) {
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    let ext = rawExt.trim().toLowerCase();
    if (!ext.startsWith(".")) ext = "." + ext;
    ids[ext] = rawId.trim();
  }
  for (const ext of extensions) {
    if (!ids[ext] && LANGUAGE_BY_EXTENSION[ext]) ids[ext] = LANGUAGE_BY_EXTENSION[ext];
  }
  return ids;
}

function normalizeEnv(value) {
  const raw = objectOrEmpty(value);
  const env = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!key || typeof val !== "string" && typeof val !== "number") continue;
    env[key] = expand(val);
  }
  return env;
}

function normalizeServer(name, entry, logger) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    log(logger, "error", `[lsp] server "${name}" must be an object`);
    return null;
  }
  if (entry.enabled === false) return null;
  if (entry.transport && entry.transport !== "stdio") {
    log(logger, "error", `[lsp] server "${name}": only stdio is supported`);
    return null;
  }
  const command = typeof entry.command === "string" ? expand(entry.command.trim()) : "";
  if (!command) {
    log(logger, "error", `[lsp] server "${name}" has no command`);
    return null;
  }
  const extensions = normalizeExtensions(entry);
  if (!extensions.length) {
    log(logger, "error", `[lsp] server "${name}" needs extensions or languageIds`);
    return null;
  }
  const languageIds = normalizeLanguageIds(entry, extensions);
  for (const ext of extensions) {
    if (!languageIds[ext]) {
      log(logger, "error", `[lsp] server "${name}": no languageId for "${ext}"`);
      return null;
    }
  }
  return {
    id: name,
    transport: "stdio",
    command,
    args: Array.isArray(entry.args) ? entry.args.map((arg) => expand(String(arg))) : [],
    env: normalizeEnv(entry.env),
    root: entry.root ? expand(String(entry.root)) : null,
    extensions,
    languageIds,
    initializationOptions: objectOrEmpty(entry.initializationOptions),
    settings: objectOrEmpty(entry.settings),
    timeoutMs: positiveNumber(entry.timeoutMs) || DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: positiveNumber(entry.idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS,
  };
}

function readServers(raw, logger) {
  const source = raw === undefined ? config.readLsp() : raw;
  const servers = source && source.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  const out = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      log(logger, "error", `[lsp] invalid server name "${name}" (use [A-Za-z0-9_-]{1,32})`);
      continue;
    }
    const server = normalizeServer(name, entry, logger);
    if (server) out.push(server);
  }
  return out;
}

function languageIdFor(server, extension) {
  const ext = String(extension || "").toLowerCase();
  return (server.languageIds && server.languageIds[ext]) || LANGUAGE_BY_EXTENSION[ext] || "plaintext";
}

const __exports = { readServers, languageIdFor, LANGUAGE_BY_EXTENSION };
export { readServers, languageIdFor, LANGUAGE_BY_EXTENSION };
export default __exports;
