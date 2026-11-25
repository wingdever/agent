"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { attachTerminalWebSocket, parseTerminalUrl } from "../../../core/transports/terminal-ws.js";
import { TerminalService } from "../../../lib/terminals/index.js";

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), timeoutMs);
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data, isBinary });
    });
  });
}

function collectBinaryUntil(ws, pattern, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("websocket output did not match " + pattern));
    }, timeoutMs);
    function onMessage(data, isBinary) {
      if (!isBinary) return;
      if (!pattern.test(data.toString())) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(data);
    }
    ws.on("message", onMessage);
  });
}

async function waitForText(fn, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("condition not met");
}

test("terminal websocket URL parsing requires session and terminal ids", () => {
  assert.equal(parseTerminalUrl("/nope"), null);
  assert.equal(parseTerminalUrl("/terminal?sessionId=1"), null);
  assert.deepEqual(
    parseTerminalUrl("/terminal?sessionId=1&terminalId=term_x&cols=90&rows=25"),
    { sessionId: "1", terminalId: "term_x", cols: 90, rows: 25 },
  );
});

test("websocket sends a hello snapshot, raw input and resize; first input takes over", async () => {
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  const server = http.createServer();
  attachTerminalWebSocket(server, { terminals: service, logger: quietLogger() });
  let ws;
  try {
    const port = await listen(server);
    const terminal = await service.open("ws-owner", {
      cwd: process.cwd(),
      createdBy: "agent",
      cols: 80,
      rows: 24,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    ws = new WebSocket(
      "ws://127.0.0.1:" + port + "/terminal?sessionId=ws-owner&terminalId=" + terminal.id + "&cols=90&rows=25",
    );
    const hello = await nextMessage(ws);
    assert.equal(hello.isBinary, false);
    const payload = JSON.parse(hello.data.toString());
    assert.equal(payload.type, "hello");
    assert.equal(payload.terminalId, terminal.id);
    assert.equal(payload.cols, 90);
    assert.equal(payload.rows, 25);
    assert.equal(payload.control, "agent");
    assert.equal(payload.alive, true);
    assert.equal(typeof payload.snapshot, "string");

    const outputPromise = collectBinaryUntil(ws, /WS_SCREEN/);
    ws.send(Buffer.from("printf 'WS_SCREEN\\n'\r"));
    const output = await outputPromise;
    assert.match(output.toString(), /WS_SCREEN/);
    assert.equal(service.getInteractive("ws-owner", terminal.id).control, "user");

    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await waitForText(async () => {
      const t = service.getInteractive("ws-owner", terminal.id);
      return t.cols === 100 && t.rows === 30;
    });
    const screen = await service.readScreen("ws-owner", terminal.id, 20);
    assert.match(screen.text, /WS_SCREEN/);
    assert.doesNotMatch(screen.text, /:P/);
  } finally {
    if (ws) ws.close();
    service.disposeAll();
    await closeServer(server);
  }
});

test("reconnect restores the rendered screen after control was taken", async () => {
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  const server = http.createServer();
  attachTerminalWebSocket(server, { terminals: service, logger: quietLogger() });
  let ws1;
  let ws2;
  try {
    const port = await listen(server);
    const terminal = await service.open("ws-reconnect", { cwd: process.cwd(), createdBy: "user" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    ws1 = new WebSocket("ws://127.0.0.1:" + port + "/terminal?sessionId=ws-reconnect&terminalId=" + terminal.id);
    await nextMessage(ws1);
    ws1.send(Buffer.from("printf 'RECONNECT_OK\\n'\r"));
    await nextMessage(ws1);
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    ws2 = new WebSocket("ws://127.0.0.1:" + port + "/terminal?sessionId=ws-reconnect&terminalId=" + terminal.id);
    const hello = await nextMessage(ws2);
    const payload = JSON.parse(hello.data.toString());
    assert.equal(payload.type, "hello");
    assert.match(payload.snapshot, /RECONNECT_OK/);
    assert.equal(payload.control, "user");
  } finally {
    if (ws1) ws1.close();
    if (ws2) ws2.close();
    service.disposeAll();
    await closeServer(server);
  }
});
