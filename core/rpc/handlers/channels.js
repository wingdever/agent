"use strict";

// UI-facing channel lifecycle commands. The manager owns all runtime state;
// these handlers project its roster, forward start/stop, and edit only the
// agent binding in user/channels.json.

import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./../../../lib/paths/index.js";

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };
const noParams = { type: "object", properties: {}, additionalProperties: false };
const byId = {
  type: "object",
  properties: { id: anyId },
  required: ["id"],
  additionalProperties: false,
};
const setAgentParams = {
  type: "object",
  properties: {
    id: anyId,
    agent: { oneOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["id"],
  additionalProperties: false,
};

function service(core) {
  const channels = core.capabilities && core.capabilities.channels;
  if (!channels || typeof channels.list !== "function") {
    throw new Error("channel manager is not available");
  }
  return channels;
}

export default function defineChannelCommands(
  rpc,
  {
    channelsFile = path.join(PROJECT_ROOT, "user", "channels.json"),
    agentsDir = path.join(PROJECT_ROOT, "agents"),
  } = {}
) {
  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
  }

  // The runtime snapshot has no profile field; the binding is a config fact,
  // so it is attached here for both list responses and pushed snapshots.
  function serviceFor(core, instanceId) {
    if (!core) return null;
    if (core.channelServices instanceof Map) {
      const entry = core.channelServices.get(String(instanceId));
      if (entry) return entry;
    }
    const svc = core.channelService;
    if (!svc) return null;
    if (svc.listeners && Array.isArray(svc.listeners)) {
      const listener = svc.listeners.find((item) => String(item.instanceId) === String(instanceId));
      if (listener) return { ...svc, listener };
    }
    return svc;
  }

  function withBindings(rows, core) {
    const config = readJson(channelsFile, { channels: [] });
    const bindings = new Map();
    (config.channels || []).forEach((row) => {
      if (row && row.id != null) bindings.set(String(row.id), row.agent || null);
    });
    return rows.map((row) => {
      const base = Object.assign({}, row, {
        agent: bindings.get(String(row.instanceId)) || null,
      });
      const svc = serviceFor(core, row.instanceId);
      if (!svc) return base;
      const listener = svc.listener || null;
      const state = listener
        ? {
            messages: listener.state,
            interactions: listener.interactionListener ? listener.interactionListener.state : "disabled",
          }
        : null;
      return Object.assign(base, {
        service: {
          endpoint: svc.endpoint,
          features: svc.features || [],
          external: true,
          messages: state ? state.messages : "unknown",
          interactions: state ? state.interactions : "unknown",
        },
      });
    });
  }

  rpc.define({
    name: "channel.list",
    params: noParams,
    handler: (core) => withBindings(service(core).list(), core),
  });

  rpc.define({
    name: "channel.start",
    params: byId,
    handler: (core, value) => service(core).start(String(value.id), { by: "user" }),
  });

  rpc.define({
    name: "channel.stop",
    params: byId,
    handler: (core, value) => service(core).stop(String(value.id)),
  });

  rpc.define({
    name: "channel.setAgent",
    params: setAgentParams,
    handler: (core, value) => {
      const id = String(value.id);
      const agent = value.agent == null || value.agent === "" ? null : String(value.agent);
      if (agent && !/^[a-z][a-z0-9-]*$/.test(agent)) {
        throw new Error(`invalid agent id "${agent}"`);
      }
      if (agent && !fs.existsSync(path.join(agentsDir, agent, "config.json"))) {
        throw new Error(`unknown agent "${agent}"`);
      }
      const config = readJson(channelsFile, { channels: [] });
      const row = (config.channels || []).find((entry) => entry && String(entry.id) === id);
      if (!row) throw new Error(`unknown channel "${id}"`);
      row.agent = agent;
      fs.mkdirSync(path.dirname(channelsFile), { recursive: true });
      fs.writeFileSync(channelsFile, JSON.stringify(config, null, 2));
      const channels = service(core);
      if (typeof channels.emit === "function") channels.emit();
      return withBindings(channels.list(), core).find((entry) => String(entry.instanceId) === id) || null;
    },
  });

  // The stream stays open until the transport cancels it. The manager sends a
  // full roster snapshot on subscribe and after every status change, so a
  // client can replace its state wholesale and needs no separate status call.
  rpc.define({
    name: "channel.subscribe",
    streaming: true,
    params: noParams,
    handler: (core, value, { onEvent, onCancel }) => new Promise((resolve) => {
      const channels = service(core);
      let off = () => {};
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        off();
        resolve(null);
      };
      onCancel(finish);
      off = channels.subscribe((roster) => {
        if (done) return;
        onEvent({ type: "snapshot", channels: withBindings(roster, core) });
      });
      if (done) off();
    }),
  });
}
