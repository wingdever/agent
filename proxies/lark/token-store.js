"use strict";

// Where the rotated OAuth pair lives between runs.
//
// Refresh tokens rotate: if the new pair is not persisted, the next process starts
// with a grant the platform has already retired. Both stores are synchronous on
// read because a proxy is constructed synchronously by the registry, and async on
// write because a token rotation happens inside a network call.

import fs from "fs";
import path from "path";

export function createMemoryTokenStore(initial = {}) {
  let current = { ...initial };
  return {
    loadSync: () => ({ ...current }),
    save: async (tokens) => {
      current = { ...tokens };
    },
    snapshot: () => ({ ...current }),
  };
}

/** File store. 0600 on create: a refresh token is a credential like any other. */
export function createFileTokenStore({ file } = {}) {
  if (!file) throw new TypeError("file store needs a file path");
  return {
    loadSync() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (_) {
        return {}; // missing or corrupt file means "re-authorize", not "crash"
      }
    },
    // Rotating the pair must not erase what the consent wrote. The refresh
    // response only carries the two tokens plus their lifetime, so a naive
    // overwrite throws away the granted scope - the one record that answers
    // "what am I actually allowed to do" without another authorization.
    async save(tokens) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      let existing = {};
      try {
        existing = JSON.parse(await fs.promises.readFile(file, "utf8"));
      } catch (_) {
        existing = {};
      }
      const merged = { ...existing, ...tokens };
      await fs.promises.writeFile(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
    },
  };
}
