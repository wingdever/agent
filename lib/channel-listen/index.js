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
 * Open a long-lived SSE listener. Idempotent per (endpoint, instanceId, path).
 * Each parsed message is passed to onMessage(payload); snapshots are skipped.
 */
export function createChannelListener({
  endpoint,
  instanceId,
  path = "/messages/subscribe",
  onMessage,
  fetchImpl = globalThis.fetch,
  schedule = (fn, ms) => setTimeout(fn, ms),
  reconnectDelayMs = 1000,
  headers = {},
  onState = () => {},
  log = () => {},
} = {}) {
  if (!endpoint) throw new TypeError("channel listener needs an endpoint");
  if (!instanceId) throw new TypeError("channel listener needs an instanceId");
  if (typeof onMessage !== "function") throw new TypeError("channel listener needs onMessage");

  const listeners = createChannelListener._registry;
  const key = `${String(endpoint)}|${String(instanceId)}|${String(path)}`;
  if (listeners.has(key)) return listeners.get(key);

  let stopped = false;
  const url = String(endpoint).replace(/\/+$/, "") + path +
    "?instanceId=" + encodeURIComponent(String(instanceId));
  const setState = (state, detail = null) => {
    listener.state = state;
    try { onState({ state, detail, endpoint, instanceId, path }); } catch (_) { /* observer */ }
  };

  async function open() {
    while (!stopped) {
      try {
        setState("connecting");
        const response = await fetchImpl(url, {
          method: "GET",
          headers: Object.assign({ Accept: "text/event-stream" }, headers),
        });
        if (!response.ok || !response.body) throw new Error(`http ${response.status}`);
        setState("open");
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
        if (!stopped) {
          setState("error", (err && err.message) || String(err));
          log(`[channel-listen] ${instanceId}: ${(err && err.message) || err}`);
        }
      }
      if (stopped) break;
      setState("reconnecting");
      await new Promise((resolve) => schedule(resolve, reconnectDelayMs));
    }
    setState("stopped");
  }

  const listener = {
    key,
    url,
    instanceId: String(instanceId),
    path: String(path),
    state: "idle",
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
      setState("stopped");
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
