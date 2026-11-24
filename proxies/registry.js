"use strict";

// Slot loader for proxies (human-account grants).

import path from "path";
import { PROJECT_ROOT } from "./../lib/paths/index.js";
import { assertProxy } from "./contract.js";
import { discoverDrivers, readConfig } from "./../accounts/registry-kit.js";

const NON_DRIVER_DIRS = ["node_modules"];

export async function loadDrivers({ root = path.join(PROJECT_ROOT, "proxies") } = {}) {
  return discoverDrivers({ root, nonDriverDirs: NON_DRIVER_DIRS });
}

export function loadConfig(file = path.join(PROJECT_ROOT, "user", "proxies.json")) {
  return readConfig(file, { key: "proxies", envPrefix: "PROXY" });
}

/**
 * @param {{config?: Object, deps?: Object, root?: string}} [options]
 * @returns {Promise<Object[]>}
 */
export async function createProxies({ config = loadConfig(), deps = {}, root } = {}) {
  const drivers = await loadDrivers(root ? { root } : {});
  const instances = (config.proxies || []).filter((p) => p && p.enabled !== false);
  const built = [];

  for (const instance of instances) {
    const id = instance.id || instance.type;
    const factory = drivers.get(instance.type);
    if (!factory) {
      throw new Error(
        `unknown proxy type "${instance.type}" for instance "${id}" (known: ${[...drivers.keys()].join(", ")})`
      );
    }
    const proxy = factory({ instance: { ...instance, id }, deps });
    assertProxy(proxy);
    built.push(proxy);
  }
  return built;
}
