"use strict";

// Standalone channel service for one configured instance.
//
// It owns the platform connection, the message history (SQLite WAL), the
// instance lock and the HTTP/SSE surface core subscribes to. It does NOT
// import core: inbound messages are appended to history and published over
// SSE; a separate core process pulls them and runs the agent.
//
// This file is intentionally a thin CLI. The reusable service lifecycle lives
// in lib/channel-service/runtime.js so QQ and the Yunhu pilot share it.
//
// Usage:
//   node channel-run.js --channel wing-bot
//   node channel-run.js --channel ami-yunhu --quiet

import process from "node:process";

import { createChannels, loadConfig } from "./channels/registry.js";
import { createSdkConnect } from "./channels/feishu/sdk-connect.js";
import { createDirectFetch } from "./lib/net/direct-fetch.js";
import { startChannelService } from "./lib/channel-service/runtime.js";

function parseArgs(argv) {
  const out = { channel: null, config: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quiet") out.quiet = true;
    else if (arg === "--channel" || arg === "-c") out.channel = argv[++i];
    else if (arg.startsWith("--channel=")) out.channel = arg.slice("--channel=".length);
    else if (arg === "--config" || arg === "-C") out.config = argv[++i];
    else if (arg.startsWith("--config=")) out.config = arg.slice("--config=".length);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function makeLogger(quiet) {
  return (...parts) => {
    if (quiet) return;
    console.log(`[${stamp()}]`, ...parts);
  };
}

const HELP = `usage: node channel-run.js --channel <instance-id> [--config <file>] [--quiet]

  --channel <id>  which instance from user/channels.json to start
  --config <file> read another channels.json (tests / alternate deployments)
  --quiet         only print warnings/errors`;

function envKey(instanceId, field) {
  return `CHANNEL_${String(instanceId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${field}`;
}

function instanceEnv(instanceId, field) {
  return process.env[envKey(instanceId, field)] || "";
}

function servicePort(instance) {
  const configured = instanceEnv(instance.instanceId, "SERVICE_PORT")
    || process.env.CHANNEL_SERVICE_PORT
    || instance.options?.servicePort
    || 0;
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid service port for channel "${instance.instanceId}": ${configured}`);
  }
  return port;
}

async function channelDeps(instance, { quiet = false } = {}) {
  // The cloud host sends plain fetch through a hijacking proxy that intermittently
  // answers the Feishu API with 504. The direct fetcher ignores proxy env for the
  // token and message calls; the websocket path is unaffected.
  const fetch = createDirectFetch();
  const deps = { fetch };
  if (instance.type === "feishu") {
    const credentials = instance.credentials || {};
    deps.connect = createSdkConnect({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: instance.options?.domain === "lark" ? "lark" : "feishu",
      loggerLevel: quiet ? "error" : "warn",
    });
    deps.onStatus = (status) => {
      if (!quiet) console.log(`[${instance.instanceId}] [ws] ${status.state}${status.error ? `: ${status.error}` : ""}`);
    };
  }
  return deps;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const log = makeLogger(args.quiet);

  const config = loadConfig(args.config || undefined);
  const instances = (config.channels || []).filter((c) => c && c.enabled !== false);
  const id = args.channel || instances[0]?.id;
  if (!id) throw new Error("no channel instance configured in user/channels.json");

  const instance = instances.find((c) => c.id === id);
  if (!instance) {
    throw new Error(`unknown channel "${id}" (configured: ${instances.map((c) => c.id).join(", ") || "none"})`);
  }
  const normalized = { ...instance, instanceId: instance.id };

  try {
    const channels = await createChannels({
      config: { channels: [instance] },
      deps: await channelDeps(normalized, { quiet: args.quiet }),
    });
    const service = await startChannelService({
      instanceId: id,
      channels,
      port: servicePort(normalized),
      token: null,
      historyFile: instanceEnv(id, "HISTORY_DB") || process.env.CHANNEL_HISTORY_DB || null,
      archiveDir: instanceEnv(id, "ARCHIVE_DIR") || process.env.CHANNEL_ARCHIVE_DIR || null,
      log,
    });
    log(`[${id}] waiting for events; Ctrl-C to stop`);

    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      log(`[${id}] ${signal}, closing`);
      await service.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Keep the process alive explicitly: the manager holds no timer of its own.
    await new Promise(() => {});
  } catch (err) {
    console.error(`[channel-run] ${(err && err.stack) || err}`);
    process.exitCode = 1;
    return 1;
  }
}

main().catch((err) => {
  console.error(`[channel-run] ${(err && err.stack) || err}`);
  process.exit(1);
});
