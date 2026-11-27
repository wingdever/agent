"use strict";

// HTTP surface of the independent channel service. Two directions:
//
//   POST /proactive         core → channel: send a message, written to history
//   GET  /messages/subscribe channel → core: SSE stream of inbound messages
//
// The channel service owns the QQ socket and the message history. core never
// reaches in; it subscribes to this stream and calls the send endpoint.

import http from "node:http";

const MAX_BODY_BYTES = 256 * 1024;

function readBody(req, onTooLarge) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        onTooLarge();
        resolve(null);
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(null));
  });
}

function parseInstanceFilter(url = "") {
  const query = url.split("?")[1] || "";
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const [key, raw = ""] = pair.split("=");
    if (key === "instanceId") return decodeURIComponent(raw);
  }
  return null;
}

/**
 * @param {Object} options
 * @param {(instanceId: string) => Object|null} options.lookupChannel
 * @param {(payload: Object) => Promise<void>} [options.onDeliver] history writer
 * @param {() => Object[]} [options.getPending] messages to replay on subscribe
 * @param {(messages: Object[]) => void} [options.onReplay] called after replay
 * @param {(eventIds: string[]) => Promise<void>} [options.onAck] ack bundled into proactive
 * @param {number} [options.port] 0 picks an ephemeral port
 * @param {string} [options.host]
 * @param {Function} [options.log]
 */
export function createChannelCallback({
  lookupChannel,
  onDeliver = async () => {},
  onAck = async () => {},
  getPending = () => [],
  onReplay = () => {},
  port = 0,
  host = "127.0.0.1",
  log = () => {},
} = {}) {
  if (typeof lookupChannel !== "function") throw new TypeError("callback needs lookupChannel");

  let server = null;
  let boundPort = port;
  /** @type {Set<{res: Object, instanceId: string|null}>} */
  const subscribers = new Set();

  async function deliver(payload) {
    const instanceId = String((payload && payload.instanceId) || "");
    const conversationKey = String((payload && payload.conversationKey) || "");
    const text = String((payload && payload.text) || "");
    const ackEventId = payload && payload.ackEventId ? String(payload.ackEventId) : null;
    // A failed turn or a duplicate event carries no text: it only ACKs so the
    // message is consumed without another send or another turn.
    const ackOnly = payload && (payload.status === "failed" || payload.status === "ack");

    if (!ackOnly && (!instanceId || !conversationKey || !text)) {
      return { ok: false, error: "instanceId, conversationKey and text are required" };
    }
    if (ackOnly && ackEventId) {
      await onAck([ackEventId]);
      return { ok: true, ackOnly: true };
    }

    const channel = lookupChannel(instanceId);
    if (!channel || typeof channel.project !== "function") {
      return { ok: false, error: `unknown channel instance "${instanceId}"` };
    }

    // Proactive messages carry no passive reply id. project()'s final branch
    // sends them as active messages; QQ's active quota decides delivery.
    const message = {
      type: channel.type,
      instanceId,
      conversationKey,
      senderId: String(payload.senderId || ""),
      recvType: payload.recvType === "user" ? "user" : "group",
      replyTo: "",
      eventId: String(payload.eventId || ""),
      messages: [],
      attachments: [],
    };

    try {
      await channel.project(message, { type: "final", content: text });
      await onDeliver({ ...payload, message });
      if (ackEventId) await onAck([ackEventId]);
      return { ok: true };
    } catch (err) {
      log(`[channel-callback] ${instanceId} deliver failed: ${(err && err.stack) || err}`);
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  function writeFrame(res, payload) {
    if (res.writableEnded || res.destroyed) return false;
    return res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** Push an inbound message to every matching subscriber. */
  function publish(message) {
    if (!message || typeof message !== "object") return { sent: 0, eventIds: [] };
    const instanceId = String(message.instanceId || "");
    let sent = 0;
    for (const sub of subscribers) {
      if (sub.instanceId && sub.instanceId !== instanceId) continue;
      if (writeFrame(sub.res, message)) sent += 1;
    }
    return { sent, eventIds: message.eventId ? [String(message.eventId)] : [] };
  }

  async function subscribe(req, res) {
    const instanceId = parseInstanceFilter(req.url);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const subscriber = { res, instanceId };
    subscribers.add(subscriber);
    log(`[channel-callback] subscribed ${instanceId || "all"}`);

    const remove = () => {
      if (!subscribers.delete(subscriber)) return;
      log(`[channel-callback] unsubscribed ${instanceId || "all"}`);
    };
    req.on("close", remove);
    res.on("close", remove);
    res.on("error", remove);

    // Snapshot first: a status frame (client skips it) followed by pending
    // messages as ordinary frames so a reconnecting core replays them.
    let pending = [];
    if (typeof getPending === "function") {
      try { pending = await getPending(instanceId) || []; }
      catch (err) { log(`[channel-callback] getPending failed: ${(err && err.message) || err}`); }
    }
    pending = pending.filter((m) => !instanceId || String((m && m.instanceId) || "") === instanceId);
    if (res.destroyed || res.writableEnded) return;
    writeFrame(res, { type: "snapshot", count: pending.length, instanceId });
    for (const message of pending) writeFrame(res, message);
    if (pending.length) {
      try { await onReplay(pending); }
      catch (err) { log(`[channel-callback] replay hook failed: ${(err && err.message) || err}`); }
    }
  }

  function listen() {
    if (server) return Promise.resolve(address());
    server = http.createServer((req, res) => {
      const path = (req.url || "").split("?")[0];
      if (path === "/messages/subscribe" && req.method === "GET") {
        subscribe(req, res).catch((err) => {
          log(`[channel-callback] subscribe failed: ${(err && err.message) || err}`);
          if (!res.writableEnded) res.end();
        });
        return;
      }
      if (path === "/proactive" && req.method === "POST") {
        return readBody(req, () => res.writeHead(413).end("too large")).then(async (body) => {
          if (body === null) return;
          let payload;
          try {
            payload = JSON.parse(body || "{}");
          } catch (_) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "bad json" }));
          }
          const result = await deliver(payload);
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        });
      }
      res.writeHead(404);
      res.end("not found");
    });
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(boundPort, host, () => {
        boundPort = server.address().port;
        resolve(address());
      });
    });
  }

  function address() {
    return {
      host,
      port: boundPort,
      url: `http://${host}:${boundPort}`,
      subscribeUrl: `http://${host}:${boundPort}/messages/subscribe`,
      sendUrl: `http://${host}:${boundPort}/proactive`,
    };
  }

  function close() {
    return new Promise((resolve) => {
      for (const sub of subscribers) {
        if (!sub.res.writableEnded) sub.res.end();
      }
      subscribers.clear();
      if (!server) return resolve();
      const current = server;
      server = null;
      current.close(resolve);
    });
  }

  return { listen, close, address, deliver, publish, subscriberCount: () => subscribers.size };
}
