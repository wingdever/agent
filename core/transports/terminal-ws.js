"use strict";

// One WebSocket per visible terminal. The protocol is deliberately small:
//
//   client -> server: binary  raw keyboard bytes
//                     text    {type:"resize",cols,rows} / {type:"ping"}
//   server -> client: text    {type:"hello",snapshot,seq,...}
//                     binary  raw PTY output
//                     text    {type:"exit"|"error"|"pong"}
//
// The first binary input atomically flips control to the user. The server
// never writes a terminal from this channel by itself; output is a mirror of
// the PTY and input is the browser's keyboard.

import { WebSocketServer, WebSocket } from "ws";

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const DRAIN_INTERVAL_MS = 50;
const MAX_COLS = 500;
const MAX_ROWS = 300;

function parseInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function parseTerminalUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl || "/", "http://127.0.0.1");
  } catch (_) {
    return null;
  }
  if (url.pathname !== "/terminal") return null;
  const sessionId = url.searchParams.get("sessionId");
  const terminalId = url.searchParams.get("terminalId");
  if (!sessionId || !terminalId) return null;
  return {
    sessionId,
    terminalId,
    cols: parseInteger(url.searchParams.get("cols"), 120, 2, MAX_COLS),
    rows: parseInteger(url.searchParams.get("rows"), 30, 2, MAX_ROWS),
  };
}

function openTerminalConnection(core, ws, options) {
  const { sessionId, terminalId, cols, rows } = options;
  const logger = core.logger || console;
  let terminal;
  try {
    terminal = core.terminals.getInteractive(sessionId, terminalId);
  } catch (error) {
    sendJson(ws, { type: "error", error: String(error.message || error) });
    ws.close(1008, "terminal not found");
    return;
  }

  let ready = false;
  let closed = false;
  let paused = false;
  let drainTimer = null;
  let exitInfo = null;
  const pending = [];

  const clearDrain = () => {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
  };

  const resumeIfDrained = () => {
    if (!paused || closed) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount <= LOW_WATER) {
      paused = false;
      clearDrain();
      try { terminal.resume(); } catch (_) {}
    }
  };

  const maybePause = () => {
    if (paused || closed) return;
    if (ws.bufferedAmount <= HIGH_WATER) return;
    paused = true;
    try { terminal.pause(); } catch (_) {}
    drainTimer = setInterval(resumeIfDrained, DRAIN_INTERVAL_MS);
    drainTimer.unref?.();
  };

  const sendOutput = (data) => {
    if (closed || !data) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(Buffer.from(String(data), "utf8"), { binary: true });
    } catch (_) {
      return;
    }
    maybePause();
  };

  const onRaw = (data, seq) => {
    if (!ready) {
      pending.push({ data, seq: Number.isFinite(seq) ? seq : terminal.rawSeq });
      return;
    }
    sendOutput(data);
  };
  const onExit = (info) => {
    exitInfo = info;
    if (ready) {
      sendJson(ws, { type: "exit", exitCode: info.exitCode, signal: info.signal || null });
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, "terminal exited");
      }, 30);
    }
  };
  const unsubscribeRaw = terminal.subscribe(onRaw);
  const unsubscribeExit = terminal.onExit(onExit);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearDrain();
    if (paused) {
      paused = false;
      try { terminal.resume(); } catch (_) {}
    }
    unsubscribeRaw();
    unsubscribeExit();
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  Promise.resolve()
    .then(() => terminal.resize(cols, rows))
    .then(() => terminal.snapshot())
    .then((snapshot) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      const payload = {
        type: "hello",
        terminalId: terminal.id,
        seq: snapshot.seq,
        snapshot: snapshot.data,
        cols: snapshot.cols,
        rows: snapshot.rows,
        control: snapshot.control,
        createdBy: snapshot.createdBy,
        alive: terminal.alive,
        running: terminal.runningStatus(),
      };
      if (!sendJson(ws, payload)) return;
      ready = true;
      // Chunks after the snapshot sequence are not represented in the screen
      // image and must be replayed; earlier chunks are already in it.
      for (const item of pending) {
        if (item.seq > snapshot.seq) sendOutput(item.data);
      }
      pending.length = 0;
      if (exitInfo) onExit(exitInfo);
    })
    .catch((error) => {
      sendJson(ws, { type: "error", error: String(error.message || error) });
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "terminal snapshot failed");
    });

  ws.on("message", (raw, isBinary) => {
    if (closed) return;
    if (isBinary) {
      try {
        terminal.input(raw.toString("utf8"));
      } catch (error) {
        sendJson(ws, { type: "error", error: String(error.message || error) });
      }
      return;
    }

    let message;
    try { message = JSON.parse(Buffer.from(raw).toString("utf8")); } catch (_) { return; }
    if (!message || typeof message.type !== "string") return;
    if (message.type === "ping") {
      sendJson(ws, { type: "pong" });
      return;
    }
    if (message.type === "resize") {
      const nextCols = parseInteger(message.cols, cols, 2, MAX_COLS);
      const nextRows = parseInteger(message.rows, rows, 2, MAX_ROWS);
      Promise.resolve()
        .then(() => terminal.resize(nextCols, nextRows))
        .catch((error) => sendJson(ws, { type: "error", error: String(error.message || error) }));
    }
  });
}

function attachTerminalWebSocket(server, core, options = {}) {
  if (!core?.terminals) return null;
  if (core.terminalPanelEnabled === false) return null;
  const wss = new WebSocketServer({ noServer: true });
  const logger = options.logger || core.logger || console;

  server.on("upgrade", (req, socket, head) => {
    const parsed = parseTerminalUrl(req.url);
    if (!parsed) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      logger.info?.(`[terminal-ws] attach ${parsed.terminalId} to session ${parsed.sessionId}`);
      openTerminalConnection(core, ws, parsed);
    });
  });

  server.on("close", () => {
    for (const client of wss.clients) {
      try { client.close(1001, "server shutting down"); } catch (_) {}
    }
    wss.close();
  });

  return wss;
}

const __exports = { attachTerminalWebSocket, parseTerminalUrl, openTerminalConnection };
export { attachTerminalWebSocket, parseTerminalUrl, openTerminalConnection };
export default __exports;
