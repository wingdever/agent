"use strict";

// Generic standalone channel-service runtime.
//
// QQ proved the shape: one process owns the platform connection, the message
// history (SQLite WAL), the service lock and the HTTP/SSE surface; core is a
// separate consumer. This module is the reusable part, so any driver can run
// embedded (local manager) or standalone (this runtime) without copying
// channel-run.js.
//
// It deliberately knows nothing about QQ or Yunhu: it receives a built
// channel, one instance id and the service options.

import path from "node:path";
import process from "node:process";

import { createChannelCallback } from "../../channels/callback.js";
import { createChannelManager } from "../../channels/manager.js";
import { createDedupe } from "../../channels/inbound/dedupe.js";
import { createChannelHistory } from "../channel-history/index.js";
import { createSqliteAdapter } from "../channel-history/sqlite-adapter.js";
import { acquireChannelLock, releaseChannelLock } from "../channel-lock.js";
import { ensureServiceToken } from "../channel-token.js";
import { PROJECT_ROOT } from "../paths/index.js";

const DEFAULT_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function defaultHistoryFile(instanceId) {
  return path.join(PROJECT_ROOT, "data", "channels", `history-${instanceId}.db`);
}

function defaultArchiveDir(type, instanceId) {
  return path.join(PROJECT_ROOT, "data", "archive", type || "channel", instanceId);
}

/**
 * Start one standalone channel service.
 *
 * @param {Object} options
 * @param {string} options.instanceId
 * @param {Object[]} options.channels  built channel instances (normally one)
 * @param {string} [options.token]     shared bearer token; auto-created if omitted
 * @param {number} [options.port]      0 = ephemeral
 * @param {string} [options.host]
 * @param {string} [options.historyFile]
 * @param {string} [options.archiveDir]
 * @param {number} [options.archiveIntervalMs]
 * @param {number} [options.olderThanDays]
 * @param {Function} [options.log]
 * @returns {Promise<{address, snapshot, history, manager, callback, state, stop}>}
 */
export async function startChannelService({
  instanceId,
  channels = [],
  token = null,
  port = 0,
  host = "127.0.0.1",
  historyFile = null,
  archiveDir = null,
  dedupeFile = null,
  archiveIntervalMs = DEFAULT_ARCHIVE_INTERVAL_MS,
  olderThanDays = 90,
  log = () => {},
} = {}) {
  const id = String(instanceId || "");
  if (!id) throw new TypeError("startChannelService needs an instanceId");
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError("startChannelService needs at least one channel");
  }

  const lock = acquireChannelLock(id);
  if (!lock.ok) {
    throw new Error(`channel "${id}" is already running (pid ${lock.pid}); stop it or remove ${lock.file}`);
  }
  const dropLock = () => releaseChannelLock(lock.file);

  const serviceToken = token || ensureServiceToken();
  const historyPath = historyFile || defaultHistoryFile(id);
  const archivePath = archiveDir || defaultArchiveDir(channels[0].type, id);
  const state = { deadLetters: 0 };

  let db = null;
  let history = null;
  let callback = null;
  let manager = null;
  let archiveTimer = null;
  let stopped = false;
  let outboundSeq = 0;

  const runArchive = async () => {
    if (!history) return;
    try {
      const archived = await history.archive({
        olderThanDays,
        archiveDir: archivePath,
        archiveAdapter: createSqliteAdapter,
      });
      if (archived.length) {
        log(`[${id}] archived ${archived.length} month(s): ${archived.map((r) => r.month).join(", ")}`);
      }
      const dead = await history.getDeadLetters(id, 1000);
      state.deadLetters = dead.length;
      if (dead.length) log(`[${id}] WARNING: ${dead.length} dead-lettered message(s) need inspection`);
    } catch (err) {
      log(`[${id}] archive failed: ${(err && err.message) || err}`);
    }
  };

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    if (archiveTimer) {
      clearInterval(archiveTimer);
      archiveTimer = null;
    }
    try {
      if (manager) await manager.stopAll();
    } catch (err) {
      log(`[${id}] stop failed: ${(err && err.message) || err}`);
    }
    try {
      if (callback) await callback.close();
    } catch (_) { /* already closed */ }
    try {
      if (db && typeof db.close === "function") db.close();
    } catch (_) { /* already closed */ }
    dropLock();
  };

  try {
    db = await createSqliteAdapter({ file: historyPath });
    history = createChannelHistory({ db });
    log(`[${id}] history: SQLite WAL ${historyPath}`);
    await runArchive();
    if (archiveIntervalMs > 0) archiveTimer = setInterval(() => { runArchive(); }, archiveIntervalMs);

    callback = createChannelCallback({
      port,
      host,
      token: serviceToken,
      features: ["messages", "proactive", "auth"].concat(
        channels.some((channel) => channel.capabilities && channel.capabilities.canPromptUser)
          ? ["interactions"]
          : []
      ),
      getStatus: () => ({
        ...(manager ? manager.status(id) : {}),
        deadLetters: state.deadLetters,
      }),
      lookupChannel: (candidate) => (String(candidate) === id ? channels[0] : null),
      getPending: (candidate) => history.getPending(candidate),
      onReplay: (messages) => history.markPublished(messages.map((m) => m.eventId)),
      onAck: (ids) => history.ack(ids),
      onDeliver: async (payload) => {
        outboundSeq += 1;
        const eventId = `out:${Date.now()}:${outboundSeq}`;
        await history.appendOutbound({
          eventId,
          instanceId: String(payload.instanceId || id),
          conversationKey: String(payload.conversationKey || ""),
          direction: "outbound",
          messages: [{ role: "assistant", content: String(payload.text || "") }],
        });
      },
      log,
    });
    const address = await callback.listen();
    log(`[${id}] channel service on ${address.url}`);

    manager = createChannelManager({
      channels,
      log,
      publish: async (message) => {
        await history.append(message);
        const result = callback.publish(message);
        if (result.sent > 0) await history.markPublished(result.eventIds);
        // Published is not acknowledged: the service replays until core ACKs.
      },
      dedupeFactory: () => createDedupe({
        file: dedupeFile || path.join(PROJECT_ROOT, "data", "channels", `dedupe-${id}.json`),
      }),
      publishInteraction: (interaction) => callback.publishInteraction({
        ...interaction,
        instanceId: interaction.instanceId || id,
      }),
    });
    const snapshot = await manager.start(id, { by: "channel-service" });
    log(`[${id}] ${snapshot.status} eventMode=${snapshot.eventMode} streaming=${snapshot.streaming}`);

    return {
      id,
      address,
      snapshot,
      history,
      manager,
      callback,
      state,
      stop: cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export default { startChannelService };
