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
  getStatus = () => null,
  features = ["messages", "interactions", "proactive", "auth"],
  port = 0,
  host = "127.0.0.1",
  token = null,
  log = () => {},
} = {}) {
  if (typeof lookupChannel !== "function") throw new TypeError("callback needs lookupChannel");

  let server = null;
  let boundPort = port;
  /** @type {Set<{res: Object, instanceId: string|null}>} */
  const subscribers = new Set();
  /** @type {Set<{res: Object, instanceId: string|null}>} */
  const interactionSubscribers = new Set();

  function authorized(req) {
    if (!token) return true;
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const direct = String(req.headers["x-channel-token"] || "");
    return bearer === token || direct === token;
  }

  function rejectUnauthorized(res) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  }


  async function deliver(payload) {
    const instanceId = String((payload && payload.instanceId) || "");
    const conversationKey = String((payload && payload.conversationKey) || "");
    const text = String((payload && payload.text) || "");
    const ackEventId = payload && payload.ackEventId ? String(payload.ackEventId) : null;
    // A failed turn or a duplicate event carries no text: it only ACKs so the
    // message is consumed without another send or another turn.
    const ackOnly = payload && (payload.status === "failed" || payload.status === "ack");

    // A card event (approval / question / plan review) is projected through
    // the driver without sending or acknowledging a message. It must not be
    // mistaken for a text send: the turn is suspended waiting for the click.
    const event = payload && payload.event && typeof payload.event === "object"
      ? payload.event
      : null;

    if (!ackOnly && !event && (!instanceId || !conversationKey || !text)) {
      return { ok: false, error: "instanceId, conversationKey and text are required" };
    }
    if (ackOnly && ackEventId) {
      try {
        await onAck([ackEventId]);
        return { ok: true, ackOnly: true, acked: true };
      } catch (err) {
        log(`[channel-callback] ack-only failed: ${(err && err.stack) || err}`);
        return { ok: false, sent: false, acked: false, error: (err && err.message) || String(err) };
      }
    }

    const channel = lookupChannel(instanceId);
    if (!channel || typeof channel.project !== "function") {
      return { ok: false, error: `unknown channel instance "${instanceId}"` };
    }

    const message = {
      type: channel.type,
      instanceId,
      conversationKey,
      senderId: String(payload.senderId || ""),
      recvType: payload.recvType === "user" ? "user" : "group",
      // Keep the passive reply window for cards: an approval card is a reply
      // to the message that triggered the turn, not an active push.
      replyTo: String(payload.replyTo || ""),
      eventId: String(payload.eventId || ""),
      messages: [],
      attachments: [],
    };
    if (event) {
      try {
        await channel.project(message, event);
        return { ok: true, sent: true, acked: false, event: true };
      } catch (err) {
        log(`[channel-callback] ${instanceId} project event failed: ${(err && err.stack) || err}`);
        return { ok: false, sent: false, acked: false, error: (err && err.message) || String(err) };
      }
    }

    let sent = false;
    let acked = false;
    try {
      await channel.project(message, { type: "final", content: text });
      sent = true;
      await onDeliver({ ...payload, message });
      if (ackEventId) {
        await onAck([ackEventId]);
        acked = true;
      }
      return { ok: true, sent: true, acked };
    } catch (err) {
      log(`[channel-callback] ${instanceId} deliver failed: ${(err && err.stack) || err}`);
      // sent=true distinguishes "the user already received it, only the ACK
      // failed" from "nothing was delivered". The former must not be retried
      // into a duplicate QQ message.
      return { ok: false, sent, acked, error: (err && err.message) || String(err) };
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

  /**
   * Push a button/approval/question callback to core. The platform click is
   * already acknowledged by the driver; this is the decision hand-off, not a
   * new inbound message, so it never enters message history.
   */
  function publishInteraction(interaction) {
    if (!interaction || typeof interaction !== "object") return { sent: 0 };
    const instanceId = String(interaction.instanceId || "");
    let sent = 0;
    for (const sub of interactionSubscribers) {
      if (sub.instanceId && instanceId && sub.instanceId !== instanceId) continue;
      if (writeFrame(sub.res, { type: "interaction", ...interaction })) sent += 1;
    }
    return { sent };
  }

  async function subscribeInteractions(req, res) {
    const instanceId = parseInstanceFilter(req.url);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const subscriber = { res, instanceId };
    interactionSubscribers.add(subscriber);
    log(`[channel-callback] interactions subscribed ${instanceId || "all"}`);
    const remove = () => {
      if (!interactionSubscribers.delete(subscriber)) return;
      log(`[channel-callback] interactions unsubscribed ${instanceId || "all"}`);
    };
    req.on("close", remove);
    res.on("close", remove);
    res.on("error", remove);
    writeFrame(res, { type: "snapshot", stream: "interactions", instanceId });
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
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          service: "channel",
          features,
          authRequired: Boolean(token),
          status: (() => { try { return getStatus(); } catch (_) { return null; } })(),
          host,
          port: boundPort,
        }));
        return;
      }
      if (path === "/messages/subscribe" && req.method === "GET") {
        if (!authorized(req)) return rejectUnauthorized(res);
        subscribe(req, res).catch((err) => {
          log(`[channel-callback] subscribe failed: ${(err && err.message) || err}`);
          if (!res.writableEnded) res.end();
        });
        return;
      }
      if (path === "/interactions/subscribe" && req.method === "GET") {
        if (!authorized(req)) return rejectUnauthorized(res);
        subscribeInteractions(req, res).catch((err) => {
          log(`[channel-callback] interaction subscribe failed: ${(err && err.message) || err}`);
          if (!res.writableEnded) res.end();
        });
        return;
      }
      if (path === "/proactive" && req.method === "POST") {
        if (!authorized(req)) return rejectUnauthorized(res);
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
      healthUrl: `http://${host}:${boundPort}/health`,
      subscribeUrl: `http://${host}:${boundPort}/messages/subscribe`,
      interactionsUrl: `http://${host}:${boundPort}/interactions/subscribe`,
      sendUrl: `http://${host}:${boundPort}/proactive`,
    };
  }

  function close() {
    return new Promise((resolve) => {
      for (const sub of subscribers) {
        if (!sub.res.writableEnded) sub.res.end();
      }
      subscribers.clear();
      for (const sub of interactionSubscribers) {
        if (!sub.res.writableEnded) sub.res.end();
      }
      interactionSubscribers.clear();
      if (!server) return resolve();
      const current = server;
      server = null;
      current.close(resolve);
    });
  }

  return {
    listen,
    close,
    address,
    deliver,
    publish,
    publishInteraction,
    subscriberCount: () => subscribers.size,
    interactionSubscriberCount: () => interactionSubscribers.size,
  };
}
