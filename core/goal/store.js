"use strict";

// The goal module's own storage (goal.md §1.1). The generic Store exposes the
// primitives (add a row, read, run SQL); the table, the append order and the
// row shape belong to this module, so adding goal touches only this file.
//
// `goal_changes` is the goal's event source: every accepted mutation appends
// one full-snapshot row, `operation=round` records an admitted round, and
// `clear` writes a tombstone. The current state is folded from these rows by
// state.js; nothing here caches it.

const TABLE = "goal_changes";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id               integer  PRIMARY KEY,
  session_id       integer  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  revision         integer  NOT NULL,
  operation        text     NOT NULL,
  goal_id          text     NOT NULL,
  objective        text,
  max_goal_rounds  integer,
  blocked_code     text,
  blocked_message  text,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
)`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_goal_changes_session ON ${TABLE} (session_id, id)`;

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    revision: Number(row.revision),
    operation: row.operation,
    goalId: row.goal_id,
    objective: row.objective == null ? undefined : row.objective,
    maxGoalRounds: row.max_goal_rounds == null ? undefined : Number(row.max_goal_rounds),
    ...(row.blocked_code
      ? { blockedReason: { code: row.blocked_code, message: row.blocked_message || "" } }
      : {}),
    at: row.created_at,
  };
}

// One goal store over a Store instance. `serialize` is the store's cross-
// statement critical section: two appends must never pick the same id.
class GoalStore {
  constructor(store) {
    if (!store) throw new Error("GoalStore requires a store");
    this.store = store;
    this.db = store.db;
    this._serial = (task) => (typeof store._serial === "function" ? store._serial(task) : task());
    this.ready = null;
  }

  ensureSchema() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.db.exec(CREATE_TABLE);
        await this.db.exec(CREATE_INDEX);
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  async list(sessionId) {
    await this.ensureSchema();
    const rows = await this.db
      .prepare(`SELECT * FROM ${TABLE} WHERE session_id=$1 ORDER BY id`)
      .all(sessionId);
    return rows.map(mapRow);
  }

  // Append one change. The id is the append order inside the session: the fold
  // reads rows by id and rejects revisions that do not advance one at a time.
  async append({ sessionId, revision, operation, goalId, objective, maxGoalRounds, blockedReason }) {
    await this.ensureSchema();
    return this._serial(async () => {
      const next = await this.db.prepare(`SELECT COALESCE(MAX(id),0)+1 AS n FROM ${TABLE}`).get();
      const id = Number(next.n);
      await this.db.prepare(
        `INSERT INTO ${TABLE} (id, session_id, revision, operation, goal_id, objective, max_goal_rounds, blocked_code, blocked_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ).run(
        id,
        sessionId,
        revision,
        operation,
        goalId,
        objective == null ? null : objective,
        maxGoalRounds == null ? null : maxGoalRounds,
        blockedReason ? blockedReason.code : null,
        blockedReason ? blockedReason.message : null,
      );
      return mapRow(await this.db.prepare(`SELECT * FROM ${TABLE} WHERE id=$1`).get(id));
    });
  }
}

function createGoalStore(store) {
  return new GoalStore(store);
}

const __exports = { GoalStore, createGoalStore, CREATE_TABLE, CREATE_INDEX, TABLE };
export { GoalStore, createGoalStore, CREATE_TABLE, CREATE_INDEX, TABLE };
export default __exports;
