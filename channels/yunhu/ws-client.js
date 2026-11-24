"use strict";

// 云湖 long-connection subscriber.
//
// The console offers two mutually exclusive delivery modes: "server event push"
// (the platform POSTs to a webhook you host) and "long connection" (we dial
// wss://ws.jwzhd.com/subscribe and the platform pushes frames on that socket).
// This module is the second one. It needs no public endpoint, which is why it
// replaces the webhook as the default: no tunnel, no DNS name, nothing to expose.
//
// Frame shape seen on the live gateway (bot 83683850, group 846015667):
//   {"version":"1.0",
//    "header":{"eventId":"…","eventType":"message.receive.normal","eventTime":…},
//    "event":{"sender":{…},"chat":{…},"message":{…}}}
// It is the same envelope the webhook receives, so parsing stays in events.js.
//
// Reconnect is deliberate: the socket is the channel's whole inbound path, and
// a bot that silently stops receiving is worse than one that says it is down.

export const DEFAULT_WS_URL = "wss://ws.jwzhd.com/subscribe";

/** The console prints this URL; the token is the only variable part. */
export function wsUrlForToken(token, base = DEFAULT_WS_URL) {
  return `${String(base).replace(/\/+$/, "")}?token=${encodeURIComponent(String(token))}`;
}

export function createWsClient({
  url,
  dial = (target) => new WebSocket(target),
  onEnvelope,
  onError,
  minDelayMs = 1000,
  maxDelayMs = 30000,
  schedule = (fn, ms) => setTimeout(fn, ms),
  connectTimeoutMs = 10000,
} = {}) {
  if (!url) throw new TypeError("ws client needs a url");
  if (typeof dial !== "function") throw new TypeError("dial must be a function");
  if (typeof onEnvelope !== "function") throw new TypeError("ws client needs an onEnvelope handler");

  const stats = { frames: 0, ignored: 0, connects: 0, closes: 0, reconnects: 0, errors: 0 };
  let socket = null;
  let stopped = true;
  let delay = minDelayMs;
  let pendingOpen = null;

  function report(error, kind = "socket") {
    stats.errors++;
    if (typeof onError === "function") onError(error, kind);
  }

  function handleFrame(raw) {
    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch (err) {
      // A non-JSON frame is not worth a reconnect; count it and move on.
      stats.ignored++;
      return;
    }
    if (!payload || !payload.header || !payload.header.eventType) {
      // Heartbeats and control frames carry no eventType.
      stats.ignored++;
      return;
    }
    stats.frames++;
    try {
      onEnvelope(payload);
    } catch (err) {
      report(err, "handler");
    }
  }

  function attach(current) {
    current.addEventListener("open", () => {
      stats.connects++;
      delay = minDelayMs;
      if (pendingOpen) {
        const { resolve } = pendingOpen;
        pendingOpen = null;
        resolve();
      }
    });

    current.addEventListener("message", (ev) => {
      if (ev && ev.data !== undefined) handleFrame(ev.data);
    });

    current.addEventListener("close", (ev) => {
      stats.closes++;
      if (socket === current) socket = null;
      if (pendingOpen) {
        const reject = pendingOpen.reject;
        pendingOpen = null;
        reject(new Error(`yunhu ws closed before open (${(ev && ev.code) || "?"})`));
        return;
      }
      if (stopped) return;
      // Reconnect is the difference between "temporarily detached" and "dead".
      const wait = delay;
      delay = Math.min(delay * 2, maxDelayMs);
      stats.reconnects++;
      schedule(() => {
        if (!stopped) open();
      }, wait);
    });

    current.addEventListener("error", (ev) => {
      report(new Error(`yunhu ws error: ${(ev && (ev.message || ev.type)) || "unknown"}`));
    });
  }

  function open() {
    const current = dial(url);
    socket = current;
    const promise = new Promise((resolve, reject) => {
      pendingOpen = { resolve, reject };
      schedule(() => {
        if (pendingOpen && pendingOpen.reject === reject) {
          pendingOpen = null;
          reject(new Error("yunhu ws did not open in time"));
        }
      }, connectTimeoutMs);
    });
    attach(current);
    return promise;
  }

  return {
    stats,
    get status() {
      if (stopped) return "stopped";
      return socket ? "connecting" : "reconnecting";
    },

    /** Resolves once the socket is open; rejects if the first attempt never opens. */
    async connect() {
      if (socket) return;
      stopped = false;
      return open();
    },

    async close() {
      stopped = true;
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close();
        } catch (err) {
          report(err, "close");
        }
      }
    },
  };
}
