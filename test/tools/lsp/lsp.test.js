"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspService } from "../../../core/lsp/index.js";
import { readServers } from "../../../core/lsp/config.js";
import { splitLines, toLspPosition } from "../../../core/lsp/position.js";
import { loadTools } from "../../../core/tools/registry.js";
import lspTool from "../../../tools/lsp/run.js";
import { formatLspResult } from "../../../tools/lsp/format.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/lsp-server.js", import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lsp-tools-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function quietLogger() {
  return { info() {}, warn() {}, error() {}, log() {} };
}

function fakeService(dir, extra = {}) {
  return new LspService({
    servers: [{
      id: "fake",
      command: process.execPath,
      args: [FIXTURE],
      extensions: [".js"],
      languageIds: { ".js": "javascript" },
      root: null,
      env: extra.env || {},
      initializationOptions: {},
      settings: {},
      timeoutMs: extra.timeoutMs || 1000,
      idleTimeoutMs: extra.idleTimeoutMs || 60000,
    }],
    logger: quietLogger(),
  });
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForLog(file, predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entries = readLog(file);
    if (entries.some(predicate)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readLog(file);
}

test("the lsp tool is one visible code-group tool with a fixed LSP contract", async () => {
  const tools = await loadTools();
  const tool = tools.get("lsp");
  assert.ok(tool);
  assert.equal(tool.group, "code");
  assert.equal(tool.defaultVisible, true);
  assert.equal(tool.mode, "read");
  assert.equal(tool.promptSection, "lsp");
  assert.deepEqual(Object.keys(tool.parameters.properties), [
    "operation", "file_path", "line", "character",
  ]);
  assert.deepEqual(tool.parameters.properties.operation.enum, [
    "goToDefinition", "findReferences", "goToImplementation", "hover",
  ]);
  assert.match(tool.description, /one-based UTF-16/);
});

test("position conversion is 1-based UTF-16 and tolerates CRLF", () => {
  assert.deepEqual(toLspPosition("a😀b", 1, 4), { line: 0, character: 3 });
  assert.deepEqual(toLspPosition("a\r\nb", 2, 1), { line: 1, character: 0 });
  assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
  assert.throws(() => toLspPosition("abc", 1, 5), /past the end of line/);
  assert.throws(() => toLspPosition("abc", 2, 1), /past the end of the file/);
});

test("config parser skips invalid entries and derives language ids", () => {
  const servers = readServers({
    servers: {
      ok: { command: "node", extensions: [".js"] },
      noCommand: { extensions: [".js"] },
      badTransport: { command: "node", transport: "http", extensions: [".js"] },
    },
  }, quietLogger());
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, "ok");
  assert.equal(servers[0].languageIds[".js"], "javascript");
  assert.equal(servers[0].timeoutMs, 30000);
});

test("the service opens a document once and answers all four operations", async () => {
  const dir = tempDir();
  const log = path.join(dir, "lsp.log");
  const file = path.join(dir, "sample.js");
  fs.writeFileSync(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const service = fakeService(dir, { env: { FAKE_LSP_LOG: log } });
  try {
    const definition = await service.query({
      operation: "goToDefinition", filePath: "sample.js", line: 1, character: 1, cwd: dir,
    });
    assert.equal(definition.server, "fake");
    assert.equal(definition.locations.length, 2);
    assert.deepEqual(definition.locations[1].range.start, { line: 1, character: 2 });

    const references = await service.query({
      operation: "findReferences", filePath: "sample.js", line: 1, character: 1, cwd: dir,
    });
    assert.equal(references.locations.length, 2);

    const implementation = await service.query({
      operation: "goToImplementation", filePath: "sample.js", line: 1, character: 1, cwd: dir,
    });
    assert.equal(implementation.locations.length, 1);
    // LocationLink targetSelectionRange is the cursor target.
    assert.deepEqual(implementation.locations[0].range.start, { line: 2, character: 2 });

    const hover = await service.query({
      operation: "hover", filePath: "sample.js", line: 2, character: 4, cwd: dir,
    });
    assert.equal(hover.hover.text, "cursor:1:3");

    const entries = await waitForLog(log, (entry) => entry.method === "textDocument/didOpen");
    assert.ok(entries.some((entry) => entry.method === "textDocument/didOpen"));
    assert.ok(entries.some((entry) => entry.method === "textDocument/references" &&
      entry.params.context.includeDeclaration === true));
    // The first query opened the document; later queries reused it.
    assert.equal(entries.filter((entry) => entry.method === "textDocument/didOpen").length, 1);

    fs.writeFileSync(file, "const a = 1;\nconst b = 99;\nconst c = 3;\n");
    await service.query({
      operation: "goToDefinition", filePath: "sample.js", line: 2, character: 1, cwd: dir,
    });
    const changed = await waitForLog(log, (entry) => entry.method === "textDocument/didChange");
    assert.ok(changed.some((entry) => entry.method === "textDocument/didChange" &&
      entry.params.textDocument.version === 2));
  } finally {
    await service.disposeAll();
    cleanup(dir);
  }
});

test("no configured provider returns LSP_UNAVAILABLE", async () => {
  const service = new LspService({ servers: [], logger: quietLogger() });
  await assert.rejects(
    () => service.query({ operation: "hover", filePath: "x.js", line: 1, character: 1, cwd: os.tmpdir() }),
    (error) => error.code === "LSP_UNAVAILABLE",
  );
});

test("request timeout is reported as LSP_TIMEOUT and does not leave a live child", async () => {
  const dir = tempDir();
  const file = path.join(dir, "slow.js");
  fs.writeFileSync(file, "let x = 1;\n");
  const service = fakeService(dir, { timeoutMs: 100, env: { FAKE_LSP_DELAY_MS: "1000" } });
  try {
    await assert.rejects(
      () => service.query({ operation: "hover", filePath: "slow.js", line: 1, character: 1, cwd: dir }),
      (error) => error.code === "LSP_TIMEOUT",
    );
  } finally {
    await service.disposeAll();
    cleanup(dir);
  }
});

test("a file with no-result returns empty normalized results", async () => {
  const dir = tempDir();
  const file = path.join(dir, "empty.js");
  fs.writeFileSync(file, "// no-result\n");
  const service = fakeService(dir);
  try {
    const definition = await service.query({
      operation: "goToDefinition", filePath: "empty.js", line: 1, character: 1, cwd: dir,
    });
    assert.deepEqual(definition.locations, []);
    const hover = await service.query({
      operation: "hover", filePath: "empty.js", line: 1, character: 1, cwd: dir,
    });
    assert.equal(hover.hover.text, "");
  } finally {
    await service.disposeAll();
    cleanup(dir);
  }
});

test("tool formats locations and hover, and maps service failures to Error text", async () => {
  const cwd = "/workspace";
  const locations = {
    operation: "goToDefinition",
    server: "fake",
    locations: [
      { uri: "file:///workspace/src/a.js", range: { start: { line: 10, character: 2 }, end: null } },
      { uri: "file:///workspace/src/b.js", range: { start: { line: 2, character: 0 }, end: null } },
    ],
    hover: null,
  };
  const result = await lspTool.run({
    operation: "goToDefinition", file_path: "src/a.js", line: 11, character: 3,
  }, {
    cwd,
    lsp: { query: async () => locations },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.meta.count, 2);
  assert.match(result.text, /Definitions \(2\):/);
  assert.match(result.text, /src\/a\.js:11:3/);
  assert.match(result.text, /src\/b\.js:3:1/);

  const hover = await lspTool.run({
    operation: "hover", file_path: "src/a.js", line: 11, character: 3,
  }, {
    cwd,
    lsp: { query: async () => ({ operation: "hover", server: "fake", hover: { text: "**T**" }, locations: [] }) },
  });
  assert.match(hover.text, /Hover at src\/a\.js:11:3:\n\*\*T\*\*/);

  const unavailable = await lspTool.run({
    operation: "hover", file_path: "src/a.js", line: 11, character: 3,
  }, { cwd, lsp: { query: async () => { throw Object.assign(new Error("no server"), { code: "LSP_UNAVAILABLE" }); } } });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.text, /Error: LSP_UNAVAILABLE: no server/);
});

test("format truncates oversized location lists and marks outside paths", () => {
  const locations = Array.from({ length: 60 }, (_, i) => ({
    uri: `file:///elsewhere/f${i}.js`,
    range: { start: { line: i, character: 0 }, end: null },
  }));
  const text = formatLspResult({ locations }, {
    operation: "findReferences", filePath: "/workspace/a.js", line: 1, character: 1, cwd: "/workspace",
  });
  assert.match(text, /References \(60, including declaration; showing first 50\):/);
  assert.match(text, /outside workspace/);
  assert.match(text, /10 more not shown/);
});
