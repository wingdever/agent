"use strict";

// Main agent profile + the global settings formerly held in user/settings.json.
// The main profile is agent/config.json; if it is missing or empty it is
// materialized once from assets/agent/config.json. Global agent fields
// (identity/persona/provider/model/effort) are merged into the settings view so
// every existing call site sees the profile as the single source of truth.
// Feature settings (stream/translate/web/autoCompact/...) stay in settings.json.

import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./../paths/index.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
// Agent-owned fields live in agent/config.json. Credentials (tavilyApiKey,
// translate.apiKey) stay in user/settings.json and are merged in by
// effectiveSettings without being written back to the profile.
const EXTRACTED = ["identity", "persona", "provider", "model", "effort", "stream", "reasoningControl", "translate", "web"];

const DEFAULT_MAIN = path.join(PROJECT_ROOT, "agent", "config.json");
const DEFAULT_ASSETS = path.join(PROJECT_ROOT, "assets", "agent", "config.json");
const DEFAULT_SETTINGS = path.join(PROJECT_ROOT, "user", "settings.json");
const DEFAULT_CHANNELS = path.join(PROJECT_ROOT, "user", "channels.json");
const DEFAULT_AGENTS_DIR = path.join(PROJECT_ROOT, "agents");
const DEFAULT_AGENTS_ASSETS = path.join(PROJECT_ROOT, "assets", "agents");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

export function mainProfile({ mainFile = DEFAULT_MAIN, assetsFile = DEFAULT_ASSETS } = {}) {
  const raw = readJson(mainFile, null);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length) return raw;
  const defaults = readJson(assetsFile, {});
  return writeJson(mainFile, defaults);
}

/** Credential keys that stay in user/settings.json even for nested objects. */
const CREDENTIAL_KEYS = new Set(["tavilyApiKey", "apiKey"]);

function mergeAgentField(key, profileValue, settingsValue) {
  // Nested config objects (web, translate) carry credentials in settings.json.
  // Merge profile config with settings credentials so neither is lost.
  if (profileValue && settingsValue && typeof profileValue === "object" && typeof settingsValue === "object") {
    const merged = Object.assign({}, profileValue);
    for (const [k, v] of Object.entries(settingsValue)) {
      if (CREDENTIAL_KEYS.has(k)) merged[k] = v;
      else if (merged[k] === undefined) merged[k] = v;
    }
    return merged;
  }
  return profileValue !== undefined ? profileValue : settingsValue;
}

/**
 * Merged view of the main agent profile (agent/config.json) and user settings.
 * Agent-owned fields come from the profile; credentials stay in settings.json.
 * The profile is authoritative — this function never writes settings.json.
 */
export function effectiveSettings({ settingsFile = DEFAULT_SETTINGS, mainFile = DEFAULT_MAIN, assetsFile = DEFAULT_ASSETS } = {}) {
  const settings = readJson(settingsFile, {});
  const main = mainProfile({ mainFile, assetsFile });
  const merged = Object.assign({}, settings);
  for (const key of EXTRACTED) {
    const value = mergeAgentField(key, main[key], settings[key]);
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
    else delete merged[key];
  }
  return merged;
}

/**
 * Load a complete bot agent from agents/<name>/.
 *   config.json  identity / model / persona / effort / provider
 *   loops.json   [{ on, slot, target }] — this agent's node orchestration
 *   prompt       Markdown system instruction (used as persona when config has none)
 *   tools.json   [ tool names ] allowed tools
 * Missing files are fine: each part falls back to empty. The name is validated
 * so a channel config can never point outside agents/.
 */
export function loadAgentProfile(name, { agentsDir = DEFAULT_AGENTS_DIR, assetsDir = DEFAULT_AGENTS_ASSETS } = {}) {
  const id = String(name || "");
  if (!ID_PATTERN.test(id)) throw new TypeError(`invalid agent name "${id}"`);
  const dir = path.join(agentsDir, id);
  // Like the main profile, a bot agent is materialized once from assets/ when
  // its instance directory is absent. An existing directory is never touched.
  const template = path.join(assetsDir, id);
  if (!fs.existsSync(dir) && fs.existsSync(template)) {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(template)) {
      const source = path.join(template, file);
      if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(dir, file));
    }
  }
  const config = readJson(path.join(dir, "config.json"), {});
  const loops = readJson(path.join(dir, "loops.json"), []);
  const tools = readJson(path.join(dir, "tools.json"), []);
  let prompt = "";
  try { prompt = fs.readFileSync(path.join(dir, "prompt"), "utf8").trim(); } catch (_) { /* optional */ }
  return {
    id,
    config,
    loops: Array.isArray(loops) ? loops : [],
    tools: Array.isArray(tools) ? tools : [],
    prompt,
  };
}

/** Resolve the agent profile for a channel instance. */
export function profileFor(instanceId) {
  const channels = readJson(DEFAULT_CHANNELS, { channels: [] });
  const row = (channels.channels || []).find((channel) => channel && channel.id === instanceId);
  const id = row && row.agent;
  if (!id) return mainProfile();
  if (!ID_PATTERN.test(String(id))) return {};
  return loadAgentProfile(id);
}

/** Fields that chat() already accepts; never pass unknown keys into core. */
export function chatOptions(profile) {
  if (!profile) return {};
  // A full agent profile nests fields under config; the legacy main profile is
  // flat. Accept both.
  const config = profile.config && typeof profile.config === "object" ? profile.config : profile;
  const options = {};
  const persona = config.persona || profile.prompt;
  if (typeof persona === "string" && persona) options.persona = persona;
  if (typeof config.model === "string" && config.model) options.model = config.model;
  if (typeof config.effort === "string" && config.effort) options.effort = config.effort;
  const tools = profile.tools || config.tools;
  if (Array.isArray(tools) && tools.length) options.toolNames = tools;
  return options;
}
