"use strict";

// DB adapters for channel history. Both expose the injected contract:
//   run(sql, params) / all(sql, params)
// The DuckDB adapter is used when @duckdb/node-api is installed; a memory
// adapter keeps the service runnable during the transition.

/** In-process adapter with the same SQL-less semantics the history needs. */
export function createMemoryAdapter() {
  const rows = new Map();
  return {
    kind: "memory",
    run(sql, params = []) {
      if (/INSERT OR IGNORE/.test(sql)) {
        const [id, instance, conv, payload] = params;
        if (!rows.has(id)) rows.set(id, { event_id: id, instance_id: instance, conversation_key: conv, payload, delivered_at: null });
      } else if (/UPDATE messages SET delivered_at/.test(sql)) {
        for (const id of params) {
          const row = rows.get(id);
          if (row) row.delivered_at = "now";
        }
      }
      // CREATE TABLE / INDEX are no-ops here.
    },
    all(sql, params = []) {
      let list = [...rows.values()];
      if (/conversation_key = \?/.test(sql)) {
        list = list.filter((r) => r.instance_id === params[0] && r.conversation_key === params[1]);
      } else if (/instance_id = \?/.test(sql)) {
        list = list.filter((r) => r.instance_id === params[0]);
      }
      if (/delivered_at IS NULL/.test(sql)) list = list.filter((r) => !r.delivered_at);
      const limit = Number(params[params.length - 1]) || list.length;
      return list.slice(0, limit);
    },
  };
}

/**
 * DuckDB adapter. Dynamically imports @duckdb/node-api so the module loads
 * even when the native package is absent (falls back to memory at call site).
 * Neo API: DuckDBInstance.create(file) → instance.connect() → connection.run /
 * connection.runAndReadAll(sql, params).
 */
export async function createDuckDbAdapter({ file = ":memory:", readOnly = false } = {}) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  // Read-only mode needs a real file (in-memory DB cannot be opened read-only).
  const instance = await DuckDBInstance.create(file, readOnly ? { access_mode: "READ_ONLY" } : undefined);
  const connection = await instance.connect();
  return {
    kind: "duckdb",
    readOnly,
    file,
    run(sql, params = []) {
      return connection.run(sql, params);
    },
    async all(sql, params = []) {
      const result = await connection.runAndReadAll(sql, params);
      return result.getRowObjects();
    },
    close() {
      return connection.closeSync();
    },
  };
}

export default { createMemoryAdapter, createDuckDbAdapter };
