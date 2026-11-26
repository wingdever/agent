"use strict";

// Headless runner for one channel instance (inbound).
//
// Why a script instead of the launcher: the entry point of this project is
// Electron, and a bot connection is not a window. This runs the same channel +
// manager + core stack without a UI so inbound can be exercised on a head
// machine (the cloud host has no display).
//
// Usage:
//   node channel-run.js --channel wing-bot            # turns go to core.agent.chat
//   node channel-run.js --channel wing-bot --echo      # echo the text back, no model
//   node channel-run.js --channel wing-bot --quiet
//
// Credentials come from user/channels.json with CHANNEL_<ID>_<FIELD> env overrides
// (the same loader the app uses), so nothing secret is typed on the command line.

import fs from "fs";
import path from "path";
import process from "node:process";

import { createChannels, loadConfig } from "./channels/registry.js";
import { createChannelManager } from "./channels/manager.js";
import { createDedupe } from "./channels/inbound/dedupe.js";
import { createSdkConnect } from "./channels/feishu/sdk-connect.js";
import { createSessionBinder } from "./channels/inbound/sessions.js";
import { createCore } from "./core/index.js";
import { PROJECT_ROOT } from "./lib/paths/index.js";
import { profileFor, chatOptions } from "./lib/agent-profile/index.js";
import { createDirectFetch } from "./lib/net/direct-fetch.js";

function parseArgs(argv) {
  const out = { channel: null, echo: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--echo") out.echo = true;
    else if (arg === "--quiet") out.quiet = true;
    else if (arg === "--channel" || arg === "-c") out.channel = argv[++i];
    else if (arg.startsWith("--channel=")) out.channel = arg.slice("--channel=".length);
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

const HELP = `usage: node channel-run.js --channel <instance-id> [--echo] [--quiet]

  --channel <id>  which instance from user/channels.json to start
  --echo          do not call the model; echo the incoming text back as a card
  --quiet         only print warnings/errors`;

/**
 * One instance per channel: a second process would open a second websocket and
 * the platform would treat this machine as two clients, delivering every event
 * twice. A stale lock (dead pid) is taken over instead of blocking the restart.
 */
function acquireLock(instanceId) {
  const file = path.join(PROJECT_ROOT, "data", "channels", `run-${instanceId}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8"));
    if (held && held.pid) {
      try {
        process.kill(Number(held.pid), 0);
        return { ok: false, file, pid: Number(held.pid) };
      } catch (_) {
        // dead holder: fall through and take over
      }
    }
  } catch (_) {
    // no lock or unreadable lock: take it
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return { ok: true, file, pid: process.pid };
}

function releaseLock(file) {
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8"));
    if (held && Number(held.pid) === process.pid) fs.unlinkSync(file);
  } catch (_) {
    // nothing to release
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const log = makeLogger(args.quiet);

  const config = loadConfig();
  const instances = (config.channels || []).filter((c) => c && c.enabled !== false);
  const id = args.channel || instances[0]?.id;
  if (!id) throw new Error("no channel instance configured in user/channels.json");

  const instance = instances.find((c) => c.id === id);
  if (!instance) {
    throw new Error(`unknown channel "${id}" (configured: ${instances.map((c) => c.id).join(", ") || "none"})`);
  }

  // Take the instance lock before opening the store or the socket: a refused
  // duplicate should fail cheaply, not after allocating resources.
  const lock = acquireLock(id);
  if (!lock.ok) {
    throw new Error(`channel "${id}" is already running (pid ${lock.pid}); stop it or remove ${lock.file}`);
  }
  const dropLock = () => releaseLock(lock.file);

  // The cloud host sends plain fetch through a hijacking proxy that intermittently
  // answers the Feishu API with 504. The direct fetcher ignores proxy env for the
  // token and message calls; the websocket path is unaffected.
  const fetchImpl = createDirectFetch();

  // The production transport seam. transport.js is JSON and only speaks to the
  // fake platform; the real long connection is protobuf and needs the SDK.
  const deps = { fetch: fetchImpl };
  if (instance.type === "feishu") {
    const credentials = instance.credentials || {};
    deps.connect = createSdkConnect({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: instance.options?.domain === "lark" ? "lark" : "feishu",
      loggerLevel: args.quiet ? "error" : "warn",
    });
    deps.onStatus = (status) => log(`[ws] ${status.state}${status.error ? `: ${status.error}` : ""}`);
  }

  // Build only the requested instance: an unused bot sitting in "stopped" is fine,
  // but there is no reason to even resolve a driver we are not going to start.
  const channels = await createChannels({ config: { channels: [instance] }, deps });
  const manager = createChannelManager({
    channels,
    log,
    dedupeFactory: () =>
      createDedupe({ file: path.join(PROJECT_ROOT, "data", "channels", `dedupe-${id}.json`) }),
  });

  let core = null;
  let turns = 0;
  if (args.echo) {
    manager.setSink({
      runTurn: async (message, emit) => {
        turns++;
        const text = (message.messages || []).map((m) => m.content).join("\n");
        log(`[echo] ${message.conversationKey} ${message.eventId}: ${text.slice(0, 120)}`);
        emit({ type: "token", content: `回显：${text}` });
        emit({ type: "done" });
      },
    });
  } else {
    core = await createCore();
    // core addresses sessions by store id; a chat id is not one. The binder maps
    // the conversation key to a session row and keeps that row across restarts.
    const sessions = createSessionBinder({
      store: core.store,
      file: path.join(PROJECT_ROOT, "data", "channels", `sessions-${id}.json`),
      workspaceFolder: PROJECT_ROOT,
    });
    manager.setSink({
      runTurn: async (message, emit) => {
        turns++;
        const sessionId = await sessions.resolve(message);
        return core.agent.chat(Object.assign({
          sessionId,
          messages: message.messages,
          onEvent: emit,
          inputSource: `channel:${message.type}:${message.instanceId}`,
          // No channel-side approver exists: `ask` would leave the turn hanging.
          autonomy: "autonomous",
        }, chatOptions(profileFor(message.instanceId))));
      },
    });
  }

  const snapshot = await manager.start(id, { by: "channel-run" }).catch((err) => {
    dropLock();
    throw err;
  });
  log(
    `[${id}] ${snapshot.status} eventMode=${snapshot.eventMode} streaming=${snapshot.streaming} ` +
      `mode=${args.echo ? "echo" : "model"}`
  );
  log(`[${id}] waiting for events; Ctrl-C to stop`);

  const heartbeat = setInterval(() => {
    const current = manager.status(id);
    log(`[${id}] deliveries=${current.deliveries} turns=${turns} status=${current.status}`);
  }, 60_000);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    log(`[${id}] ${signal}, closing`);
    try {
      await manager.stopAll();
      if (core && core.browser) await core.browser.stop();
    } finally {
      dropLock();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive explicitly: the manager holds no timer of its own, and
  // the websocket is owned by the SDK, so a resolved promise here would exit early.
  await new Promise(() => {});
}

main().then(
  (code) => {
    if (typeof code === "number") process.exit(code);
  },
  (err) => {
    console.error(`[channel-run] ${(err && err.stack) || err}`);
    process.exit(1);
  }
);
