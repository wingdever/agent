"use strict";

// SQLite (WAL) adapter for channel history. Unlike DuckDB, SQLite WAL supports
// one writer + multiple readers ACROSS PROCESSES on the same host, so core can
// open the channel service's file read-only instead of going over HTTP.
//
// Dynamically imported so the module loads before the native package is
// installed. pg-micro is not used here: it does not expose a read-only/shared
// lock mode (verified: a second process gets "File is locked by another process").

export async function createSqliteAdapter({ file = ":memory:", readonly = false } = {}) {
  // ESM named export from better-sqlite3 (CJS) may be default or module itself.
  const mod = await import("better-sqlite3");
  const Database = mod.default || mod;
  const db = new Database(file, { readonly, fileMustExist: readonly });
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
  }
  return {
    kind: "sqlite",
    file,
    readonly,
    run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
    close() {
      return db.close();
    },
  };
}

export default { createSqliteAdapter };
