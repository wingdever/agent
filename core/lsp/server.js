"use strict";

// One language-server process and the document state that belongs to it. The
// service owns provider selection and the server map; this class owns the LSP
// handshake, didOpen/didChange bookkeeping, request serialization, idle
// shutdown and crash recovery.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  HoverRequest,
  ImplementationRequest,
  InitializedNotification,
  InitializeRequest,
  ReferencesRequest,
  ShutdownRequest,
} from "vscode-languageserver-protocol";
import { LspProtocol } from "./protocol.js";
import { LspError } from "./errors.js";
import { toLspPosition } from "./position.js";
import { normalizeHover, normalizeLocations } from "./results.js";

const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i;
const CAPABILITY_KEY = {
  goToDefinition: "definitionProvider",
  findReferences: "referencesProvider",
  goToImplementation: "implementationProvider",
  hover: "hoverProvider",
};

function scrubbedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CREDENTIAL_NAME.test(key) || key.startsWith("AGENT_")) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) env[key] = value;
  return env;
}

function directoryUri(root) {
  const href = pathToFileURL(root).href;
  return href.endsWith("/") ? href : href + "/";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LspServer {
  constructor(config, { logger, onClosed } = {}) {
    this.config = config;
    this.id = config.id;
    this.logger = logger;
    this.onClosed = typeof onClosed === "function" ? onClosed : null;
    this.state = "idle";
    this.child = null;
    this.protocol = null;
    this.capabilities = {};
    this.positionEncoding = null;
    this.startPromise = null;
    this.failedStarts = 0;
    this.documents = new Map();
    this.queue = Promise.resolve();
    this.closing = false;
    this.disposed = false;
    this.idleTimer = null;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === "function") {
      this.logger[level](`[lsp:${this.id}] ${message}`);
    }
  }

  _touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closing || this.disposed || this.state !== "running") return;
    this.idleTimer = setTimeout(() => {
      this.dispose().catch((error) => this._log("warn", `idle shutdown failed: ${error.message}`));
    }, this.config.idleTimeoutMs);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  async ensureStarted() {
    if (this.disposed || this.closing) {
      throw new LspError("LSP_SERVER_EXITED", `language server "${this.id}" is closed`);
    }
    if (this.state === "running" && this.protocol) {
      this._touch();
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start() {
    if (this.failedStarts >= 3) {
      throw new LspError("LSP_START_FAILED", `language server "${this.id}" failed to start three times`);
    }
    this.state = "starting";
    this.closing = false;
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.root,
      env: scrubbedEnv(this.config.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trimEnd();
        if (text) this._log("warn", text);
      });
    }
    try {
      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };
        const onError = (error) => {
          child.off("spawn", onSpawn);
          reject(new LspError("LSP_START_FAILED", `cannot start "${this.config.command}": ${error.message}`, error));
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      this.protocol = new LspProtocol(child, {
        logger: this.logger,
        name: this.id,
        onClose: () => this._onUnexpectedClose(),
      });
      const init = await this.protocol.request(InitializeRequest.type, {
        processId: process.pid,
        clientInfo: { name: "doubao-agent", version: "0.1.0" },
        rootUri: directoryUri(this.config.root),
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { workspaceFolders: true, configuration: false },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            implementation: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
        },
        workspaceFolders: [{ uri: directoryUri(this.config.root), name: path.basename(this.config.root) }],
        initializationOptions: this.config.initializationOptions || {},
      }, { timeoutMs: this.config.timeoutMs });
      this.capabilities = (init && init.capabilities) || {};
      this.positionEncoding = (init && init.capabilities && init.capabilities.positionEncoding) || "utf-16";
      if (this.positionEncoding !== "utf-16") {
        throw new LspError(
          "LSP_UNSUPPORTED_POSITION_ENCODING",
          `language server "${this.id}" selected ${this.positionEncoding}; only utf-16 is supported`,
        );
      }
      this.protocol.notify(InitializedNotification.type, {});
      if (Object.keys(this.config.settings || {}).length) {
        this.protocol.notify("workspace/didChangeConfiguration", { settings: this.config.settings });
      }
      this.state = "running";
      this.failedStarts = 0;
      this._touch();
    } catch (error) {
      this.failedStarts += 1;
      this.state = "failed";
      try { this.protocol && this.protocol.dispose(); } catch (_) { /* best effort */ }
      this.protocol = null;
      await this._killChild();
      if (error instanceof LspError) throw error;
      throw new LspError("LSP_START_FAILED", `language server "${this.id}" failed to initialize: ${error.message}`, error);
    }
  }

  _onUnexpectedClose() {
    if (this.closing || this.disposed) return;
    this._log("warn", "connection closed unexpectedly");
    this.state = "failed";
    try { this.protocol && this.protocol.dispose(); } catch (_) { /* best effort */ }
    this.protocol = null;
  }

  async _killChild() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    let exited = false;
    const onExit = () => { exited = true; };
    child.once("exit", onExit);
    try {
      child.kill("SIGTERM");
    } catch (_) {
      return;
    }
    await delay(300);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
    }
    child.off("exit", onExit);
  }

  _languageId(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return (this.config.languageIds && this.config.languageIds[ext]) || "plaintext";
  }

  async _ensureDocument(filePath) {
    let text;
    try {
      text = await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      const existing = this.documents.get(pathToFileURL(filePath).href);
      if (existing) {
        try {
          this.protocol.notify(DidCloseTextDocumentNotification.type, {
            textDocument: { uri: existing.uri },
          });
        } catch (_) { /* server may already be gone */ }
        this.documents.delete(existing.uri);
      }
      throw new LspError("LSP_FILE_NOT_FOUND", `cannot read ${filePath}: ${error.message}`, error);
    }
    const uri = pathToFileURL(filePath).href;
    const existing = this.documents.get(uri);
    if (!existing) {
      const version = 1;
      this.protocol.notify(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: this._languageId(filePath),
          version,
          text,
        },
      });
      const doc = { uri, version, text };
      this.documents.set(uri, doc);
      return doc;
    }
    if (existing.text !== text) {
      const version = existing.version + 1;
      this.protocol.notify(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      existing.version = version;
      existing.text = text;
    }
    return existing;
  }

  _supports(operation) {
    const key = CAPABILITY_KEY[operation];
    if (!key) return false;
    // Omitted capabilities are common in servers that still answer requests; only
    // an explicit false is treated as unsupported. A method-not-found response
    // remains the final fallback.
    return this.capabilities[key] !== false;
  }

  _requestFor(operation, uri, position) {
    const params = { textDocument: { uri }, position };
    if (operation === "goToDefinition") return { type: DefinitionRequest.type, params };
    if (operation === "findReferences") {
      return {
        type: ReferencesRequest.type,
        params: { ...params, context: { includeDeclaration: true } },
      };
    }
    if (operation === "goToImplementation") return { type: ImplementationRequest.type, params };
    if (operation === "hover") return { type: HoverRequest.type, params };
    return null;
  }

  async query({ operation, filePath, line, character, signal } = {}) {
    const run = async () => {
      await this.ensureStarted();
      if (!this._supports(operation)) {
        throw new LspError("LSP_UNSUPPORTED_OPERATION", `language server "${this.id}" does not support ${operation}`);
      }
      const doc = await this._ensureDocument(filePath);
      const position = toLspPosition(doc.text, line, character);
      const request = this._requestFor(operation, doc.uri, position);
      if (!request) throw new LspError("LSP_UNSUPPORTED_OPERATION", `unknown operation "${operation}"`);
      try {
        const raw = await this.protocol.request(request.type, request.params, {
          signal,
          timeoutMs: this.config.timeoutMs,
        });
        return {
          operation,
          server: this.id,
          locations: operation === "hover" ? [] : normalizeLocations(raw),
          hover: operation === "hover" ? normalizeHover(raw) : null,
        };
      } catch (error) {
        if (error && error.code === -32601) {
          throw new LspError("LSP_UNSUPPORTED_OPERATION", `language server "${this.id}" does not implement ${operation}`, error);
        }
        if (error && error.code === -32800) {
          throw new LspError("LSP_CANCELLED", `language server request for "${this.id}" was cancelled`, error);
        }
        if (error && error.code === -32801) {
          throw new LspError("LSP_CONTENT_MODIFIED", `document changed while "${this.id}" answered; retry`, error);
        }
        if (error instanceof LspError) throw error;
        throw new LspError("LSP_REQUEST_FAILED", `language server "${this.id}" failed ${operation}: ${error.message}`, error);
      }
    };
    // Serialize document mutations and requests per server. A server may support
    // concurrent requests, but didOpen/didChange ordering is the invariant that
    // matters most for a small tool loop.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next.finally(() => this._touch());
  }

  async dispose() {
    if (this.disposed) return;
    this.closing = true;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const protocol = this.protocol;
    if (protocol) {
      try {
        await protocol.request(ShutdownRequest.type, null, { timeoutMs: 2000 });
      } catch (_) { /* already gone */ }
      try { protocol.notify(ExitNotification.type); } catch (_) { /* already gone */ }
      await delay(300);
      try { protocol.dispose(); } catch (_) { /* already gone */ }
    }
    this.protocol = null;
    await this._killChild();
    this.state = "closed";
    this.documents.clear();
    if (this.onClosed) this.onClosed(this);
  }
}

const __exports = { LspServer, scrubbedEnv, directoryUri };
export { LspServer, scrubbedEnv, directoryUri };
export default __exports;
