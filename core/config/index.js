"use strict";

// Single source of user configuration: file paths, raw readers/writers, and the
// provider/model/context-window resolvers. Every service (agent, loops, model,
// compaction, rpc) goes through this module instead of reading user/*.json on
// its own.

import fs from "fs";
import path from "path";
import compaction from "./../compaction.js";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __pathDirname } from "node:path";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));


const USER_DIR = path.join(__dirname, "..", "..", "user");
const SETTINGS_FILE = path.join(USER_DIR, "settings.json");
const PROVIDERS_FILE = path.join(USER_DIR, "providers.json");
const PERMISSIONS_FILE = path.join(USER_DIR, "permissions.json");
const BASH_POLICY_FILE = path.join(USER_DIR, "bash-policy.json");
const FS_POLICY_FILE = path.join(USER_DIR, "fs-policy.json");

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

function readSettings() {
  return readJSON(SETTINGS_FILE, {});
}

function writeSettings(patch) {
  const next = Object.assign({}, readSettings(), patch || {});
  return writeJSON(SETTINGS_FILE, next);
}

// ---- providers ----

function normalizeModel(m) {
  const name = typeof m === "string" ? m : (m && m.name);
  const model = { name, fee: (m && m.fee) || "unknown", enabled: m && m.enabled === true };
  if (m && m.context_window != null && Number.isFinite(Number(m.context_window))) {
    model.context_window = Number(m.context_window);
  }
  if (m && m.effort && Array.isArray(m.effort.supported_levels)) {
    model.effort = {
      supported_levels: m.effort.supported_levels.slice(),
      default_level: m.effort.default_level || null,
    };
  }
  return model;
}

function normalizeProvider(p) {
  const out = {
    name: p.name,
    base_url: p.base_url || null,
    api_key: p.api_key || null,
    description: p.description || null,
  };
  if (p.reasoning_param) out.reasoning_param = p.reasoning_param;
  out.models = (Array.isArray(p.models) ? p.models : []).map(normalizeModel);
  return out;
}

function readProviders() {
  const raw = readJSON(PROVIDERS_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeProvider);
}

function writeProviders(list) {
  return writeJSON(PROVIDERS_FILE, Array.isArray(list) ? list : []);
}

function findProvider(name) {
  if (!name) return null;
  return readProviders().find((p) => p.name === name) || null;
}

function enabledModels(provider) {
  return ((provider && provider.models) || []).filter((m) => m && m.name && m.enabled === true);
}

// Provider credentials plus its first enabled model. Used by services that
// need a provider view without resolving a whole turn target.
function resolveProvider(name) {
  if (!name) return null;
  const p = findProvider(name);
  if (!p) return null;
  const models = enabledModels(p);
  return {
    name: p.name,
    baseUrl: p.base_url,
    apiKey: p.api_key,
    model: models.length ? models[0].name : null,
  };
}

// Resolve one turn's model target. Explicit { provider, model, baseUrl, apiKey }
// wins; otherwise settings are used; otherwise the first enabled model.
// Throws when no usable provider/model exists (fail fast at startup).
function resolveTarget({ provider, model, baseUrl, apiKey, settings } = {}) {
  const st = settings || readSettings();
  const providers = readProviders();
  const wantedProvider = provider || st.provider || null;
  const wantedModel = model || st.model || null;

  let chosen = null;
  if (wantedProvider) chosen = providers.find((p) => p.name === wantedProvider) || null;
  if (!chosen && wantedModel) {
    chosen = providers.find((p) => enabledModels(p).some((m) => m.name === wantedModel)) || null;
  }
  if (!chosen) chosen = providers.find((p) => enabledModels(p).length > 0) || null;
  if (!chosen) {
    throw new Error("no provider configured: add an enabled model to user/providers.json");
  }

  const enabled = enabledModels(chosen);
  const modelName = wantedModel || (enabled[0] && enabled[0].name);
  if (!modelName) {
    throw new Error('provider "' + chosen.name + '" has no enabled model');
  }
  return {
    provider: chosen.name,
    model: modelName,
    baseUrl: baseUrl || chosen.base_url || null,
    apiKey: apiKey || chosen.api_key || null,
  };
}

// Compatibility helper for createCore(config) callers that pass explicit fields.
function resolveDefaultFromProviders(config = {}) {
  const target = resolveTarget({
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
  return Object.assign({}, config, target);
}

// ---- context window ----

function resolveContextWindow({ provider, model, settings } = {}) {
  const st = settings || readSettings();
  const providers = readProviders();
  for (const p of providers) {
    if (provider && p.name !== provider) continue;
    for (const m of p.models || []) {
      if (model && m.name !== model) continue;
      const cw = typeof m === "object" ? Number(m.context_window) : NaN;
      if (Number.isFinite(cw) && cw > 0) return Math.floor(cw);
    }
  }
  const fromSettings = Number(st.contextWindow);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return Math.floor(fromSettings);
  return compaction.DEFAULT_CONTEXT_WINDOW;
}

// ---- reasoning parameter mapping ----

function reasoningParamFor(baseUrl) {
  const target = String(baseUrl || "").replace(/\/$/, "");
  if (!target) return "reasoning_effort";
  const p = readProviders().find((x) => String(x.base_url || "").replace(/\/$/, "") === target);
  return (p && p.reasoning_param) || "reasoning_effort";
}

// ---- generic permission files (raw shape, for settings UI) ----

function readPermissionFile(file, fallback) {
  return readJSON(file, fallback);
}

function writePermissionFile(file, data) {
  return writeJSON(file, data);
}

function permissionsSnapshot() {
  return {
    permissions: readPermissionFile(PERMISSIONS_FILE, { default: "ask", tools: [] }),
    bashPolicy: readPermissionFile(BASH_POLICY_FILE, { default: "ask", rules: [] }),
    fsPolicy: readPermissionFile(FS_POLICY_FILE, { rules: [] }),
  };
}

function readPermissionsRaw() {
  return readPermissionFile(PERMISSIONS_FILE, { default: "ask", tools: [] });
}

function writePermissionsRaw(data) {
  return writePermissionFile(PERMISSIONS_FILE, data);
}

function readBashPolicyRaw() {
  return readPermissionFile(BASH_POLICY_FILE, { default: "ask", rules: [] });
}

function writeBashPolicyRaw(data) {
  return writePermissionFile(BASH_POLICY_FILE, data);
}

function readFsPolicyRaw() {
  return readPermissionFile(FS_POLICY_FILE, { rules: [] });
}

function writeFsPolicyRaw(data) {
  return writePermissionFile(FS_POLICY_FILE, data);
}

const __exports = {
  USER_DIR,
  SETTINGS_FILE,
  PROVIDERS_FILE,
  PERMISSIONS_FILE,
  BASH_POLICY_FILE,
  FS_POLICY_FILE,
  readJSON,
  writeJSON,
  readSettings,
  writeSettings,
  readProviders,
  writeProviders,
  findProvider,
  enabledModels,
  resolveProvider,
  resolveTarget,
  resolveDefaultFromProviders,
  resolveContextWindow,
  reasoningParamFor,
  readPermissionFile,
  writePermissionFile,
  permissionsSnapshot,
  readPermissionsRaw,
  writePermissionsRaw,
  readBashPolicyRaw,
  writeBashPolicyRaw,
  readFsPolicyRaw,
  writeFsPolicyRaw,
};
export { USER_DIR, SETTINGS_FILE, PROVIDERS_FILE, PERMISSIONS_FILE, BASH_POLICY_FILE, FS_POLICY_FILE, readJSON, writeJSON, readSettings, writeSettings, readProviders, writeProviders, findProvider, enabledModels, resolveProvider, resolveTarget, resolveDefaultFromProviders, resolveContextWindow, reasoningParamFor, readPermissionFile, writePermissionFile, permissionsSnapshot, readPermissionsRaw, writePermissionsRaw, readBashPolicyRaw, writeBashPolicyRaw, readFsPolicyRaw, writeFsPolicyRaw };
export default __exports;
