"use strict";

// DB adapter surface for channel history:
//   run(sql, params) / all(sql, params)
// Production uses the SQLite adapter; this memory adapter is test-only.

/** In-process adapter with the same SQL-less semantics the history needs. */
export function createMemoryAdapter() {
  const rows = new Map();
  return {
    kind: "memory",
    run(sql, params = []) {
      if (/INSERT OR IGNORE/.test(sql)) {
        const [id, instance, conv, payload] = params;
        if (!rows.has(id)) rows.set(id, { event_id: id, instance_id: instance, conversation_key: conv, payload, delivered_at: null, attempts: 0, dead_lettered_at: null });
      } else if (/UPDATE messages SET attempts/.test(sql)) {
        const cap = Number((sql.match(/attempts \+ 1 >= (\d+)/) || [])[1]) || 5;
        for (const id of params) {
          const row = rows.get(id);
          if (row && !row.delivered_at && !row.dead_lettered_at) {
            row.attempts = (row.attempts || 0) + 1;
            row.last_attempt_at = "now";
            if (row.attempts >= cap) row.dead_lettered_at = "now";
          }
        }
      } else if (/UPDATE messages SET dead_lettered_at = NULL/.test(sql)) {
        for (const id of params) {
          const row = rows.get(id);
          if (row && row.dead_lettered_at) { row.dead_lettered_at = null; row.attempts = 0; row.last_attempt_at = null; }
        }
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
      if (/dead_lettered_at IS NULL/.test(sql)) list = list.filter((r) => !r.dead_lettered_at);
      if (/dead_lettered_at IS NOT NULL/.test(sql)) list = list.filter((r) => r.dead_lettered_at);
      const limit = Number(params[params.length - 1]) || list.length;
      return list.slice(0, limit);
    },
  };
}

export default { createMemoryAdapter };
