"use strict";

// Shared plumbing for account-binding slots (channel and proxy).
//
// Both slots behave the same way structurally: a directory is a driver, an
// instance comes from config, credentials may be injected from env. Duplicating
// that discovery logic per slot is how two slots drift apart for no reason.

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { PROJECT_ROOT } from "./../lib/paths/index.js";

/**
 * Scan a slot root for driver directories that export createChannel/createProxy.
 * @param {{root?: string, nonDriverDirs?: string[]}} [options]
 * @returns {Promise<Map<string, Function>>}
 */
export async function discoverDrivers({ root = PROJECT_ROOT, nonDriverDirs = [] } = {}) {
  const skip = new Set(["node_modules", ...nonDriverDirs]);
  const drivers = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || skip.has(entry.name)) continue;
    const entryFile = path.join(root, entry.name, "index.js");
    if (!fs.existsSync(entryFile)) continue;
    const mod = await import(pathToFileURL(entryFile).href);
    const factory = mod.createChannel || mod.createProxy;
    if (typeof factory !== "function") continue;
    drivers.set(mod.type || entry.name, factory);
  }
  return drivers;
}

/**
 * Read an instances config file, applying env overrides to credentials.
 * @param {string} file
 * @param {{key?: string, envPrefix?: string}} [options]
 */
export function readConfig(file, { key = "channels", envPrefix = "CHANNEL" } = {}) {
  let raw = { [key]: [] };
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const instances = (raw[key] || []).map((instance) => applyEnvOverrides(instance, envPrefix));
  return { ...raw, [key]: instances };
}

/**
 * The environment variable that can supply one credential field. Exported so a
 * driver's "credential missing" error can name the exact variable a user should
 * set, instead of leaving them to guess the naming convention.
 *
 * @param {string} instanceId
 * @param {string} field
 * @param {string} [envPrefix]
 */
export function envNameFor(instanceId, field, envPrefix = "CHANNEL") {
  const envBase = envPrefix + "_" + String(instanceId).toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_";
  return envBase + String(field).replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/**
 * Credentials may come from env (`<PREFIX>_<ID>_<FIELD>`), which wins over the
 * file. Keeps container/CI runs free of secrets on disk.
 */
export function applyEnvOverrides(instance, envPrefix = "CHANNEL") {
  if (!instance || !instance.id) return instance;
  const credentials = { ...(instance.credentials || {}) };
  for (const field of Object.keys(credentials)) {
    const envName = envNameFor(instance.id, field, envPrefix);
    if (process.env[envName]) credentials[field] = process.env[envName];
  }
  return { ...instance, credentials };
}
