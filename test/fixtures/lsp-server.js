#!/usr/bin/env node
"use strict";

// A minimal LSP stdio server used by the tests. It speaks just enough protocol
// to exercise framing, document sync, the four navigation methods, timeouts and
// process shutdown without requiring gopls/pyright on the test machine.

import fs from "node:fs";

let buffer = Buffer.alloc(0);
const documents = new Map();
const logFile = process.env.FAKE_LSP_LOG || "";
const delayMs = Number(process.env.FAKE_LSP_DELAY_MS || 0);
const exitAfterInit = process.env.FAKE_LSP_EXIT_AFTER_INIT === "1";

function log(method, params) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify({ method, params }) + "\n");
  } catch (_) { /* logging is optional */ }
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function uriOf(params) {
  return params && params.textDocument && params.textDocument.uri;
}

function textOf(uri) {
  return (documents.get(uri) || {}).text || "";
}

function range(line, character) {
  return {
    start: { line, character },
    end: { line, character: character + 1 },
  };
}

function handle(message) {
  const method = message.method;
  const params = message.params || {};
  log(method, params);

  if (method === "initialize") {
    respond(message.id, {
      capabilities: {
        positionEncoding: "utf-16",
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        hoverProvider: true,
      },
      serverInfo: { name: "fake-lsp", version: "1.0.0" },
    });
    if (exitAfterInit) setTimeout(() => process.exit(0), 50);
    return;
  }
  if (method === "initialized") return;
  if (method === "textDocument/didOpen") {
    const doc = params.textDocument;
    if (doc && doc.uri) documents.set(doc.uri, { text: doc.text || "", version: doc.version || 1 });
    return;
  }
  if (method === "textDocument/didChange") {
    const uri = uriOf(params);
    const doc = documents.get(uri) || { text: "", version: 1 };
    const change = (params.contentChanges || [])[0] || {};
    if (typeof change.text === "string") doc.text = change.text;
    doc.version = (params.textDocument && params.textDocument.version) || doc.version + 1;
    documents.set(uri, doc);
    return;
  }
  if (method === "textDocument/didClose") {
    documents.delete(uriOf(params));
    return;
  }
  if (method === "shutdown") {
    respond(message.id, null);
    return;
  }
  if (method === "exit") {
    process.exit(0);
    return;
  }
  if (method === "textDocument/definition") {
    const uri = uriOf(params);
    if (textOf(uri).includes("no-result")) return respond(message.id, null);
    respond(message.id, [
      { uri, range: range(0, 0) },
      { uri, range: range(1, 2) },
    ]);
    return;
  }
  if (method === "textDocument/references") {
    const uri = uriOf(params);
    if (textOf(uri).includes("no-result")) return respond(message.id, null);
    respond(message.id, [
      { uri, range: range(0, 0) },
      { uri, range: range(2, 0) },
    ]);
    return;
  }
  if (method === "textDocument/implementation") {
    const uri = uriOf(params);
    if (textOf(uri).includes("no-result")) return respond(message.id, null);
    respond(message.id, [{
      targetUri: uri,
      targetRange: range(0, 1),
      targetSelectionRange: range(2, 2),
    }]);
    return;
  }
  if (method === "textDocument/hover") {
    const uri = uriOf(params);
    const position = params.position || {};
    if (textOf(uri).includes("no-result")) return respond(message.id, null);
    const answer = () => respond(message.id, {
      contents: { kind: "markdown", value: `cursor:${position.line}:${position.character}` },
      range: range(position.line || 0, position.character || 0),
    });
    if (delayMs > 0) setTimeout(answer, delayMs);
    else answer();
    return;
  }
  if (message.id !== undefined) respondError(message.id, -32601, `method not found: ${method}`);
}

function consume() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const total = headerEnd + 4 + length;
    if (buffer.length < total) return;
    const body = buffer.slice(headerEnd + 4, total).toString("utf8");
    buffer = buffer.slice(total);
    let message;
    try {
      message = JSON.parse(body);
    } catch (_) {
      continue;
    }
    try {
      handle(message);
    } catch (error) {
      if (message.id !== undefined) respondError(message.id, -32603, error.message);
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  consume();
});
process.stdin.on("end", () => process.exit(0));
