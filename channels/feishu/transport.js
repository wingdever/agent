"use strict";

// Long-lived event connection.
//
// This client speaks plain JSON over WebSocket, which is what a stand-in platform
// (and our own fixtures) speak. The *real* feishu long connection frames events
// with protobuf inside the socket, so production must go through the official
// SDK's WSClient instead: pass it as `deps.connect`, which has exactly this
// signature. Keeping the seam here is why the rest of the driver is testable
// without credentials or a 30MB dependency.

export function connect({
  url,
  onEvent,
  onStatus = null,
  WebSocketImpl = globalThis.WebSocket,
  retryBaseMs = 500,
  retryMaxMs = 30000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!url) throw new TypeError("connect requires a url");
  if (typeof onEvent !== "function") throw new TypeError("connect requires an onEvent handler");
  if (typeof WebSocketImpl !== "function") throw new TypeError("no WebSocket implementation available");

  let stopped = false;
  let socket = null;
  let retryTimer = null;
  let attempt = 0;

  function scheduleReconnect() {
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt++);
    retryTimer = setTimeoutImpl(open, delay);
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
  }

  function open() {
    if (stopped) return;
    socket = new WebSocketImpl(url);

    socket.addEventListener("open", () => {
      attempt = 0;
      if (onStatus) onStatus({ state: "open" });
    });

    socket.addEventListener("message", (frame) => {
      let envelope = null;
      try {
        envelope = JSON.parse(frame.data);
      } catch (_) {
        return; // a malformed frame must not kill the connection
      }
      onEvent(envelope);
    });

    socket.addEventListener("close", () => {
      if (onStatus) onStatus({ state: "closed" });
      if (!stopped) scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // Undici reports errors before close; the close handler owns reconnection.
    });
  }

  open();

  return {
    close() {
      stopped = true;
      if (retryTimer) clearTimeoutImpl(retryTimer);
      retryTimer = null;
      if (socket) {
        try {
          socket.close();
        } catch (_) {
          /* already closing */
        }
      }
      socket = null;
    },
    get attempt() {
      return attempt;
    },
  };
}
