"use strict";

// QQ 官方机器人 gateway client (opcode protocol).
//
// Different animal from yunhu's socket: the server greets with op 10 (hello) and
// a heartbeat interval, the client must identify (op 2) with a token and an
// intents bitmask, and the connection yields a session_id plus a monotonically
// increasing `s`. A reconnect without resume (op 6) loses every event that
// happened while we were away, which is why the sequence number is kept here and
// not in the driver.
//
// Verified live with the real appid: identify returned
//   op 0 t READY s 1 {"user":{"id":"10880449181683288941","username":"alice","bot":true}}
// and the heartbeat interval came back as 41250ms.

export const INTENTS = Object.freeze({
  // GROUP_AND_C2C_EVENT: group @-messages and direct messages. This is the bit
  // that matters for a group bot; guild events are a different bit entirely.
  GROUP_AND_C2C: 1 << 25,
});

const OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
});

export function createQqGateway({
  auth,
  fetchGateway,
  dial = (url) => new WebSocket(url),
  onDispatch,
  onReady,
  onError,
  intents = INTENTS.GROUP_AND_C2C,
  shard = [0, 1],
  openTimeoutMs = 20000,
  reconnectDelayMs = 5000,
  schedule = (fn, ms) => setTimeout(fn, ms),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof fetchGateway !== "function") throw new TypeError("qq gateway needs fetchGateway");
  if (typeof onDispatch !== "function") throw new TypeError("qq gateway needs onDispatch");

  const stats = { connects: 0, disconnects: 0, heartbeats: 0, resumes: 0, reidentifies: 0, dispatches: 0, errors: 0 };

  let socket = null;
  let stopped = true;
  let heartbeat = null;
  let sessionId = null;
  let seq = null;
  let pendingReady = null;

  function report(err) {
    stats.errors++;
    if (typeof onError === "function") onError(err);
  }

  function stopHeartbeat() {
    if (heartbeat !== null) clearIntervalImpl(heartbeat);
    heartbeat = null;
  }

  async function identify(current) {
    const headers = await auth.headers();
    // `Authorization: QQBot <token>` -> the socket wants the full value.
    current.send(JSON.stringify({ op: OP.IDENTIFY, d: { token: headers.Authorization, intents, shard } }));
  }

  function resume(current) {
    return auth.headers().then((headers) => {
      current.send(JSON.stringify({ op: OP.RESUME, d: { token: headers.Authorization, session_id: sessionId, seq } }));
      stats.resumes++;
    });
  }

  function handleFrame(current, raw) {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch (err) {
      report(new Error("qq gateway sent a non-JSON frame"));
      return;
    }

    switch (frame.op) {
      case OP.HELLO: {
        const interval = Number(frame.d && frame.d.heartbeat_interval) || 41250;
        heartbeat = setIntervalImpl(() => {
          if (!socket) return;
          socket.send(JSON.stringify({ op: OP.HEARTBEAT, d: seq }));
          stats.heartbeats++;
        }, interval);
        if (sessionId) resume(current);
        else identify(current);
        return;
      }
      case OP.DISPATCH: {
        if (typeof frame.s === "number") seq = frame.s;
        if (frame.t === "READY") {
          sessionId = (frame.d && frame.d.session_id) || null;
          if (typeof onReady === "function") onReady(frame.d || {});
          if (pendingReady) {
            const { resolve } = pendingReady;
            pendingReady = null;
            resolve();
          }
          return;
        }
        if (frame.t === "RESUMED" && pendingReady) {
          const { resolve } = pendingReady;
          pendingReady = null;
          resolve();
          return;
        }
        stats.dispatches++;
        try {
          onDispatch(frame);
        } catch (err) {
          report(err);
        }
        return;
      }
      case OP.RECONNECT:
        // Server asks us to start over; resume is still allowed.
        if (current) current.close();
        return;
      case OP.INVALID_SESSION:
        sessionId = null;
        seq = null;
        stats.reidentifies++;
        identify(current);
        return;
      case OP.HEARTBEAT_ACK:
        return;
      default:
        // Unknown opcodes are logged through stats rather than thrown: one odd
        // frame must not tear down a working connection.
        report(new Error(`qq gateway sent unknown op ${frame.op}`));
    }
  }

  function open(current) {
    const ready = new Promise((resolve, reject) => {
      pendingReady = { resolve, reject };
      schedule(() => {
        if (pendingReady && pendingReady.reject === reject) {
          pendingReady = null;
          reject(new Error("qq gateway did not become ready in time"));
        }
      }, openTimeoutMs);
    });

    current.addEventListener("message", (ev) => handleFrame(current, ev.data));
    current.addEventListener("close", (ev) => {
      stopHeartbeat();
      stats.disconnects++;
      if (socket === current) socket = null;
      if (pendingReady) {
        const { reject } = pendingReady;
        pendingReady = null;
        reject(new Error(`qq gateway closed before ready (${(ev && ev.code) || "?"})`));
        return;
      }
      if (stopped) return;
      // dialUrl() already attaches handlers and returns the ready promise, so
      // reopening is just calling it again — but nobody awaits that promise, and
      // a redial that never becomes ready (or fails) must not surface as an
      // unhandled rejection: it becomes an error stat plus another attempt.
      const reopen = () => {
        if (stopped) return;
        dialUrl().catch((err) => {
          stats.errors += 1;
          try {
            onError && onError(err);
          } catch {}
          if (!stopped) schedule(reopen, reconnectDelayMs);
        });
      };
      schedule(reopen, reconnectDelayMs);
    });
    current.addEventListener("error", (ev) => report(new Error(`qq gateway socket error: ${(ev && ev.type) || "unknown"}`)));

    return ready;
  }

  let gatewayUrl = null;
  function dialUrl() {
    const current = dial(gatewayUrl);
    socket = current;
    stats.connects++;
    return open(current);
  }

  return {
    stats,
    get sessionId() {
      return sessionId;
    },
    get seq() {
      return seq;
    },

    /** Fetch the per-bot gateway URL, dial, identify, and resolve on READY. */
    async connect() {
      if (socket) return;
      stopped = false;
      const gateway = await fetchGateway();
      gatewayUrl = gateway && gateway.url;
      if (!gatewayUrl) throw new Error("qq gateway returned no url");
      return dialUrl();
    },

    async close() {
      stopped = true;
      sessionId = null;
      seq = null;
      stopHeartbeat();
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close();
        } catch (err) {
          report(err);
        }
      }
    },
  };
}
