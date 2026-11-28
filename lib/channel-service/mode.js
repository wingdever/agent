"use strict";

// Per-instance deployment mode for a channel.
//
// The driver is the same in both modes; only who owns the platform connection
// changes:
//   embedded -> launcher's local manager (in-process sink)
//   service  -> channel-run + lib/channel-service/runtime (core-pull)
//
// `options.serviceMode` wins. For backward compatibility a global
// CHANNEL_SERVICE_ENDPOINT still means "QQ lives in the standalone service";
// other drivers stay embedded unless explicitly promoted, so a pilot cannot
// attach to the QQ endpoint by accident.

export function channelEnv(instanceId, field) {
  return `CHANNEL_${String(instanceId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${field}`;
}

export function channelServiceMode(instance, env = process.env) {
  const configured = instance && instance.options && instance.options.serviceMode;
  if (configured === "embedded") return "embedded";
  if (configured === "service" || configured === "microservice") return "service";
  if (instance && instance.type === "qq" && env && env.CHANNEL_SERVICE_ENDPOINT) return "service";
  return "embedded";
}

export function channelServiceEndpoint(instance, env = process.env) {
  if (!instance) return "";
  const instanceId = instance.instanceId || instance.id;
  return (env && env[channelEnv(instanceId, "SERVICE_ENDPOINT")])
    || (instance.options && instance.options.serviceEndpoint)
    || (instance.type === "qq" && env ? env.CHANNEL_SERVICE_ENDPOINT : "")
    || "";
}

export default { channelEnv, channelServiceMode, channelServiceEndpoint };
