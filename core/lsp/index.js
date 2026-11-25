"use strict";

// LSP service: provider registry, file-to-provider selection, and the shared
// server map. It deliberately does not expose protocol types to tools; tools
// call query() and receive normalized locations or hover text.

import fs from "node:fs";
import path from "node:path";
import { LspError } from "./errors.js";
import { readServers } from "./config.js";
import { LspServer } from "./server.js";

class StdioLspProvider {
  constructor(entry) {
    this.id = entry.id;
    this.extensions = entry.extensions.slice();
    this.languageIds = { ...entry.languageIds };
    this.root = entry.root || null;
    this.entry = entry;
  }

  match(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensions.includes(ext) ? { languageId: this.languageIds[ext] || "plaintext" } : null;
  }

  create(root, { logger, onClosed } = {}) {
    return new LspServer({ ...this.entry, root }, { logger, onClosed });
  }
}

class LspService {
  constructor({ servers, logger } = {}) {
    this.logger = logger || console;
    this.providers = [];
    this.servers = new Map();
    const entries = servers === undefined ? readServers(undefined, this.logger) : servers;
    for (const entry of entries || []) this.registerProvider(new StdioLspProvider(entry));
  }

  registerProvider(provider) {
    if (!provider || typeof provider.id !== "string" || !provider.id) {
      throw new TypeError("LSP provider needs a non-empty id");
    }
    if (typeof provider.match !== "function" || typeof provider.create !== "function") {
      throw new TypeError(`LSP provider "${provider.id}" needs match() and create()`);
    }
    this.providers.push(provider);
    return provider;
  }

  _providerFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    let selected = null;
    let selectedLength = -1;
    for (const provider of this.providers) {
      if (!provider.match(filePath)) continue;
      const matching = provider.extensions
        ? provider.extensions.filter((value) => ext.endsWith(value)).map((value) => value.length)
        : [];
      const length = matching.length ? Math.max(...matching) : 0;
      // First provider wins a tie; longest extension (e.g. .d.ts if declared) wins otherwise.
      if (length > selectedLength) {
        selected = provider;
        selectedLength = length;
      }
    }
    return selected;
  }

  _rootFor(provider, cwd) {
    if (!provider.root) return cwd;
    return path.isAbsolute(provider.root) ? provider.root : path.resolve(cwd, provider.root);
  }

  _getServer(provider, root) {
    const key = provider.id + "\0" + root;
    let server = this.servers.get(key);
    if (server && server.state !== "closed") return server;
    if (server) this.servers.delete(key);
    server = provider.create(root, {
      logger: this.logger,
      onClosed: (closed) => {
        if (this.servers.get(key) === closed) this.servers.delete(key);
      },
    });
    this.servers.set(key, server);
    return server;
  }

  async query({ operation, filePath, line, character, cwd, signal } = {}) {
    const base = cwd || process.cwd();
    const absPath = path.resolve(base, filePath);
    const provider = this._providerFor(absPath);
    if (!provider) {
      const ext = path.extname(absPath) || "(no extension)";
      throw new LspError("LSP_UNAVAILABLE", `no language server configured for "${ext}"`);
    }
    const root = this._rootFor(provider, base);
    try {
      if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new LspError("LSP_ROOT_NOT_FOUND", `LSP root "${root}" is not a directory`, error);
    }
    const server = this._getServer(provider, root);
    return server.query({ operation, filePath: absPath, line, character, signal });
  }

  async disposeAll() {
    const servers = Array.from(this.servers.values());
    this.servers.clear();
    await Promise.all(servers.map((server) => server.dispose().catch(() => {})));
  }
}

const __exports = { LspService, StdioLspProvider };
export { LspService, StdioLspProvider };
export default __exports;
