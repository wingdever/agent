"use strict";

// Core-side listener for the channel service's SSE message stream.
//
// The channel service owns the QQ socket and the history; it exposes
// /messages/subscribe. This module establishes the connection, reads frames,
// and hands every message straight to onMessage — there is no inbox buffer.
// The node layer decides what a message means (open a turn).

function parseSseChunk(chunk, carry = "") {
  const text = carry + chunk;
  const lines = text.split("\n");
  const carryOut = lines.pop() || "";
  const frames = [];
  let buffer = "";
  for (const line of lines) {
    if (line === "") {
      if (buffer) { frames.push(buffer); buffer = ""; }
      continue;
    }
    if (line.startsWith("data:")) {
      buffer += (buffer ? "\n" : "") + line.slice(5).trimStart();
    }
  }
  return { frames, carry: carryOut };
}

/**
 * Open a long-lived SSE listener. Idempotent per (endpoint, instanceId).
 * Each parsed message is passed to onMessage(payload); snapshots are skipped.
 */
export function createChannelListener({
  endpoint,
  instanceId,
  onMessage,
  fetchImpl = globalThis.fetch,
  schedule = (fn, ms) => setTimeout(fn, ms),
  reconnectDelayMs = 1000,
  log = () => {},
} = {}) {
  if (!endpoint) throw new TypeError("channel listener needs an endpoint");
  if (!instanceId) throw new TypeError("channel listener needs an instanceId");
  if (typeof onMessage !== "function") throw new TypeError("channel listener needs onMessage");

  const listeners = createChannelListener._registry;
  const key = `${String(endpoint)}|${String(instanceId)}`;
  if (listeners.has(key)) return listeners.get(key);

  let stopped = false;
  const url = String(endpoint).replace(/\/+$/, "") +
    "/messages/subscribe?instanceId=" + encodeURIComponent(String(instanceId));

  async function open() {
    while (!stopped) {
      try {
        const response = await fetchImpl(url, { method: "GET", headers: { Accept: "text/event-stream" } });
        if (!response.ok || !response.body) throw new Error(`http ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let carry = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseSseChunk(decoder.decode(value, { stream: true }), carry);
          carry = parsed.carry;
          for (const frame of parsed.frames) {
            if (frame === "[DONE]") continue;
            let payload;
            try { payload = JSON.parse(frame); } catch (_) { continue; }
            if (!payload || payload.type === "snapshot" || !payload.eventId) continue;
            try { await onMessage(payload); }
            catch (err) { log(`[channel-listen] ${instanceId} handler failed: ${(err && err.message) || err}`); }
          }
        }
      } catch (err) {
        if (!stopped) log(`[channel-listen] ${instanceId}: ${(err && err.message) || err}`);
      }
      if (stopped) break;
      await new Promise((resolve) => schedule(resolve, reconnectDelayMs));
    }
  }

  const listener = {
    key,
    url,
    start() {
      if (!listener._started) {
        listener._started = true;
        open().catch((err) => log(`[channel-listen] fatal: ${(err && err.message) || err}`));
      }
      return listener;
    },
    stop() {
      stopped = true;
      listeners.delete(key);
    },
    _started: false,
  };
  listeners.set(key, listener);
  return listener;
}
createChannelListener._registry = new Map();

export function stopAllListeners() {
  for (const sub of [...createChannelListener._registry.values()]) sub.stop();
}

export { parseSseChunk };
export default { createChannelListener, stopAllListeners, parseSseChunk };
