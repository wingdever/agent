"use strict";

// Standalone channel service for one channel instance.
//
// It owns the QQ/Feishu connection, the message history (SQLite WAL), and the HTTP
// surface core subscribes to. It does NOT import core: inbound messages are
// appended to history and published over SSE; a separate core process pulls
// them and runs the agent.
//
// Usage:
//   node channel-run.js --channel wing-bot           # run the service
//   node channel-run.js --channel wing-bot --quiet
//
// Credentials come from user/channels.json with CHANNEL_<ID>_<FIELD> env overrides
// (the same loader the app uses), so nothing secret is typed on the command line.

import fs from "fs";
import path from "path";
import process from "node:process";

import { createChannels, loadConfig } from "./channels/registry.js";
import { createChannelManager } from "./channels/manager.js";
import { createChannelCallback } from "./channels/callback.js";
import { createDedupe } from "./channels/inbound/dedupe.js";
import { createChannelHistory } from "./lib/channel-history/index.js";
import { createMemoryAdapter } from "./lib/channel-history/adapters.js";
import { createSqliteAdapter } from "./lib/channel-history/sqlite-adapter.js";
import { createSdkConnect } from "./channels/feishu/sdk-connect.js";
import { PROJECT_ROOT } from "./lib/paths/index.js";
import { createDirectFetch } from "./lib/net/direct-fetch.js";

function parseArgs(argv) {
  const out = { channel: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quiet") out.quiet = true;
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

const HELP = `usage: node channel-run.js --channel <instance-id> [--quiet]

  --channel <id>  which instance from user/channels.json to start
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
  // Message history: SQLite WAL when the native package is available, memory
  // otherwise. Accepted inbound/outbound messages are appended here; pending
  // (undelivered) messages are replayed when a subscriber reconnects.
  const historyFile = process.env.CHANNEL_HISTORY_DB ||
    path.join(PROJECT_ROOT, "data", "channels", `history-${id}.db`);
  let db = createMemoryAdapter();
  try {
    db = await createSqliteAdapter({ file: historyFile });
    log(`[${id}] history: SQLite WAL ${historyFile}`);
  } catch (err) {
    log(`[${id}] SQLite unavailable, using memory history: ${(err && err.message) || err}`);
  }
  const history = createChannelHistory({ db });
  // Archive delivered messages older than 90 days into monthly SQLite files.
  // Runs once at startup; pending (undelivered) messages are never archived.
  const archiveDir = process.env.CHANNEL_ARCHIVE_DIR ||
    path.join(PROJECT_ROOT, "data", "archive", "qq");
  if (db.kind === "sqlite") {
    const archived = await history.archive({
      olderThanDays: 90, archiveDir, archiveAdapter: createSqliteAdapter,
    });
    if (archived.length) log(`[${id}] archived ${archived.length} month(s): ${archived.map((r) => r.month).join(", ")}`);
  }

  // The channel service publishes accepted inbound messages over SSE so a
  // separate core process can subscribe (core-pull). In this headless runner
  // core is still in-process; both paths receive the message during the
  // transition.
  let outboundSeq = 0;
  const callback = createChannelCallback({
    // Fixed port when configured so core can point CHANNEL_SERVICE_ENDPOINT at
    // it; 0 (default) picks an ephemeral port for tests/dev.
    port: Number(process.env.CHANNEL_SERVICE_PORT || 0),
    lookupChannel: (candidate) => (String(candidate) === id ? channels[0] : null),
    getPending: (instanceId) => history.getPending(instanceId),
    // Replays count as delivery attempts; only an explicit ACK from core
    // marks a message delivered.
    onReplay: (messages) => history.markPublished(messages.map((m) => m.eventId)),
    // ACK is bundled into POST /proactive by core (ackEventId / status=failed).
    onAck: (ids) => history.ack(ids),
    // Record what was actually sent to QQ. Outbound messages are stored as
    // already-delivered so they never re-enter the pending queue and get
    // replayed to core as if they were inbound.
    onDeliver: async (payload) => {
      outboundSeq += 1;
      const eventId = `out:${Date.now()}:${outboundSeq}`;
      const record = {
        eventId,
        instanceId: String(payload.instanceId || id),
        conversationKey: String(payload.conversationKey || ""),
        direction: "outbound",
        messages: [{ role: "assistant", content: String(payload.text || "") }],
      };
      await history.appendOutbound(record);
    },
    log,
  });
  const callbackAddress = await callback.listen();
  log(`[${id}] channel service on ${callbackAddress.url}`);

  const manager = createChannelManager({
    channels,
    log,
    publish: async (message) => {
      await history.append(message);
      const result = callback.publish(message);
      if (result.sent > 0) await history.markPublished(result.eventIds);
      // Published is not acknowledged: a later reconnect replays this message
      // until core ACKs it via POST /messages/ack. With no subscriber the
      // message stays pending with attempts=0.
    },
    dedupeFactory: () =>
      createDedupe({ file: path.join(PROJECT_ROOT, "data", "channels", `dedupe-${id}.json`) }),
  });

  // No sink: messages go to history + SSE subscribers only. core is a separate
  // process that subscribes and runs the agent.
  const snapshot = await manager.start(id, { by: "channel-run" }).catch((err) => {
    dropLock();
    throw err;
  });
  log(`[${id}] ${snapshot.status} eventMode=${snapshot.eventMode} streaming=${snapshot.streaming}`);
  log(`[${id}] waiting for events; Ctrl-C to stop`);

  const heartbeat = setInterval(() => {
    const current = manager.status(id);
    log(`[${id}] deliveries=${current.deliveries} status=${current.status}`);
  }, 60_000);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    log(`[${id}] ${signal}, closing`);
    try {
      await manager.stopAll();
      await callback.close();
      if (db && typeof db.close === "function") db.close();
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
