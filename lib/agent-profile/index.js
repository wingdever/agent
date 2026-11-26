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
const EXTRACTED = ["identity", "persona", "provider", "model", "effort"];

const DEFAULT_MAIN = path.join(PROJECT_ROOT, "agent", "config.json");
const DEFAULT_ASSETS = path.join(PROJECT_ROOT, "assets", "agent", "config.json");
const DEFAULT_SETTINGS = path.join(PROJECT_ROOT, "user", "settings.json");
const DEFAULT_CHANNELS = path.join(PROJECT_ROOT, "user", "channels.json");
const DEFAULT_AGENTS_DIR = path.join(PROJECT_ROOT, "agents");

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

/**
 * One-time migration plus merged view. Settings values for the extracted keys
 * are moved into the main profile and deleted from settings.json; afterwards
 * the main profile is authoritative and settings.json is never written by this
 * function again.
 */
export function effectiveSettings({ settingsFile = DEFAULT_SETTINGS, mainFile = DEFAULT_MAIN, assetsFile = DEFAULT_ASSETS } = {}) {
  const settings = readJson(settingsFile, {});
  const main = mainProfile({ mainFile, assetsFile });
  const migrated = {};
  EXTRACTED.forEach((key) => {
    if (settings[key] !== undefined) {
      migrated[key] = settings[key];
      delete settings[key];
    }
  });
  if (Object.keys(migrated).length) {
    Object.assign(main, migrated);
    writeJson(mainFile, main);
    writeJson(settingsFile, settings);
  }
  const merged = Object.assign({}, settings);
  EXTRACTED.forEach((key) => {
    const value = main[key];
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
    else delete merged[key];
  });
  return merged;
}

/** Resolve the agent profile for a channel instance. */
export function profileFor(instanceId) {
  const channels = readJson(DEFAULT_CHANNELS, { channels: [] });
  const row = (channels.channels || []).find((channel) => channel && channel.id === instanceId);
  const id = row && row.agent;
  if (!id) return mainProfile();
  if (!ID_PATTERN.test(String(id))) return {};
  return readJson(path.join(DEFAULT_AGENTS_DIR, String(id), "config.json"), {});
}

/** Fields that chat() already accepts; never pass unknown keys into core. */
export function chatOptions(profile) {
  if (!profile) return {};
  const options = {};
  if (typeof profile.persona === "string" && profile.persona) options.persona = profile.persona;
  if (typeof profile.model === "string" && profile.model) options.model = profile.model;
  if (typeof profile.effort === "string" && profile.effort) options.effort = profile.effort;
  if (Array.isArray(profile.tools) && profile.tools.length) options.toolNames = profile.tools;
  return options;
}
