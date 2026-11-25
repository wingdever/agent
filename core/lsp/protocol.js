"use strict";

// Thin adapter around vscode-jsonrpc. Keeping the dependency in this file
// isolates its CommonJS/Node stream details and leaves server.js to deal only
// with LSP methods, capabilities and document state.

import {
  CancellationTokenSource,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import { LspError } from "./errors.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

class LspProtocol {
  constructor(child, { logger, name, onClose } = {}) {
    this.name = name || "lsp";
    this.logger = logger;
    this.reader = new StreamMessageReader(child.stdout);
    this.writer = new StreamMessageWriter(child.stdin);
    this.connection = createMessageConnection(
      this.reader,
      this.writer,
      {
        error: (message) => this._log("error", message),
        warn: (message) => this._log("warn", message),
        info: (message) => this._log("info", message),
        log: (message) => this._log("log", message),
      },
    );
    this.closed = false;
    this.onClose = typeof onClose === "function" ? onClose : null;
    this.connection.onError((error) => this._log("warn", error && error.message ? error.message : String(error)));
    this.connection.onClose(() => {
      if (this.closed) return;
      this.closed = true;
      if (this.onClose) this.onClose();
    });
    this.connection.listen();
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === "function") {
      this.logger[level](`[lsp:${this.name}] ${message}`);
    }
  }

  notify(type, params) {
    if (this.closed) throw new LspError("LSP_SERVER_EXITED", `language server "${this.name}" is not running`);
    this.connection.sendNotification(type, params);
  }

  async request(type, params, { signal, timeoutMs } = {}) {
    if (this.closed) throw new LspError("LSP_SERVER_EXITED", `language server "${this.name}" is not running`);
    const source = new CancellationTokenSource();
    let timer = null;
    let removeAbort = null;
    const requestPromise = this.connection.sendRequest(type, params, source.token);
    const timeoutPromise = timeoutMs && timeoutMs > 0
      ? new Promise((_, reject) => {
        timer = setTimeout(() => {
          source.cancel();
          reject(new LspError("LSP_TIMEOUT", `language server "${this.name}" did not answer within ${timeoutMs}ms`));
        }, timeoutMs);
      })
      : null;
    const abortPromise = signal
      ? new Promise((_, reject) => {
        const onAbort = () => {
          source.cancel();
          reject(new LspError("LSP_CANCELLED", `language server request for "${this.name}" was cancelled`));
        };
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }
      })
      : null;
    try {
      const candidates = [requestPromise];
      if (timeoutPromise) candidates.push(timeoutPromise);
      if (abortPromise) candidates.push(abortPromise);
      return await Promise.race(candidates);
    } catch (error) {
      if (error instanceof LspError) throw error;
      if (signal && signal.aborted) {
        throw new LspError("LSP_CANCELLED", `language server request for "${this.name}" was cancelled`, error);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (removeAbort) removeAbort();
      source.dispose();
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    try { this.connection.dispose(); } catch (_) { /* best effort */ }
  }
}

const __exports = { LspProtocol, DEFAULT_REQUEST_TIMEOUT_MS };
export { LspProtocol, DEFAULT_REQUEST_TIMEOUT_MS };
export default __exports;
