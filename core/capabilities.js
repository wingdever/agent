"use strict";

// What a tool call is allowed to reach beyond itself.
//
// Tools never import a slot: slots are composed once at startup and handed here as
// values. That is what keeps `tools` a leaf-ish layer (no core internals, no
// channels, no providers) while still giving the model real capability: the tool
// sees "the proxies this run actually has", not the machinery behind them.
//
// Lookup is by instance id, never by position: order in config must not decide
// which human a write lands on.
//
// Channels arrive here as a *manager*, not as instances: a channel has a lifecycle
// the model may drive (start/stop), so the handle must be the thing that owns
// status, not a snapshot of it.

export function createCapabilities({ proxies = [], channels = null } = {}) {
  const byId = new Map();

  for (const proxy of proxies) {
    if (!proxy || typeof proxy !== "object") throw new TypeError("capabilities: proxy must be an object");
    if (!proxy.instanceId) throw new TypeError("capabilities: every proxy needs an instanceId");
    byId.set(String(proxy.instanceId), proxy);
  }

  if (channels) {
    if (typeof channels !== "object") throw new TypeError("capabilities: channels must be an object or null");
    for (const fn of ["list", "status", "start", "stop"]) {
      if (typeof channels[fn] !== "function") {
        throw new TypeError(`capabilities: channels.${fn} must be a function`);
      }
    }
  }

  function list() {
    return [...byId.values()].map((proxy) => ({
      instanceId: proxy.instanceId,
      type: proxy.type,
      scopes: Array.isArray(proxy.scopes) ? [...proxy.scopes] : [],
    }));
  }

  function proxy(id) {
    const key = String(id);
    const found = byId.get(key);
    if (!found) {
      const known = list().map((entry) => entry.instanceId);
      throw new Error(`unknown proxy "${key}" (known: ${known.join(", ") || "none"})`);
    }
    return found;
  }

  return {
    proxy,
    listProxies: list,
    hasProxy: (id) => byId.has(String(id)),
    // Null when the deployment has no channel slot wired in; the tool reports that
    // as "unavailable" rather than inventing a channel.
    channels,
    listChannels: () => (channels ? channels.list() : []),
  };
}
