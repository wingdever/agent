"use strict";

// Slot loader for channels (bot accounts).
//
// A slot is a directory, its entry is index.js, instances are configuration.
// The discovery and config mechanics are shared with proxies via accounts/.

import path from "path";
import { PROJECT_ROOT } from "./../lib/paths/index.js";
import { assertChannel } from "./contract.js";
import { discoverDrivers, readConfig } from "./../accounts/registry-kit.js";

const NON_DRIVER_DIRS = ["inbound", "node_modules"];

export async function loadDrivers({ root = path.join(PROJECT_ROOT, "channels") } = {}) {
  return discoverDrivers({ root, nonDriverDirs: NON_DRIVER_DIRS });
}

export function loadConfig(file = path.join(PROJECT_ROOT, "user", "channels.json")) {
  return readConfig(file, { key: "channels", envPrefix: "CHANNEL" });
}

/**
 * Build every enabled instance and validate it against the contract.
 * @param {{config?: Object, deps?: Object, root?: string}} [options]
 * @returns {Promise<Object[]>}
 */
export async function createChannels({ config = loadConfig(), deps = {}, root } = {}) {
  const drivers = await loadDrivers(root ? { root } : {});
  const instances = (config.channels || []).filter((c) => c && c.enabled !== false);
  const built = [];

  for (const instance of instances) {
    const id = instance.id || instance.type;
    const factory = drivers.get(instance.type);
    if (!factory) {
      throw new Error(
        `unknown channel type "${instance.type}" for instance "${id}" (known: ${[...drivers.keys()].join(", ")})`
      );
    }
    const channel = factory({ instance: { ...instance, id }, deps });
    assertChannel(channel);
    built.push(channel);
  }
  return built;
}
