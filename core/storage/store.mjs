// 数据持久化存储引擎（真值：docs/data-struct.md）
// 使用 pgmicro（PostgreSQL 兼容的嵌入式数据库），单文件存储于 ./data/store.db
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { connect } from "pg-micro";
import { SCHEMA_STATEMENTS } from "./schema.mjs";

// 把 jsonb 读取结果规整为对象（pgmicro 可能返回字符串或已解析对象）
function _j(v) {
  if (v == null) return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

class Store {
  constructor(db) {
    this.db = db;
    // 应用层分配 integer 主键（SELECT MAX(id)+1 再 INSERT）不是原子操作。单连接
    // pg-micro 下父子 turn 并发写会抢到同一个 id（UNIQUE constraint failed:
    // contents.id）。所有「取 id + 插行」走这条进程内串行链。
    this._writeChain = Promise.resolve();
  }

  async close() { await this.db.close(); }

  // 串行化一次「读-改-写」临界区（进程内互斥，不支持多进程）。
  _serial(task) {
    const run = this._writeChain.then(task, task);
    // 吞掉链上的错误，避免一次失败污染后续任务；错误仍会传给调用方。
    this._writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---- schema ----
  async _execSchema() {
    for (const sql of SCHEMA_STATEMENTS) await this.db.exec(sql);
  }

  // ---- 通用底层 ----
  async _nextId(table) {
    const row = await this.db.prepare(`SELECT COALESCE(MAX(id),0)+1 AS n FROM ${table}`).get();
    return Number(row.n);
  }
  async _get(table, id) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id=$1`).get(id);
  }
  async _list(table, where = {}, order) {
    const keys = Object.keys(where);
    let sql = `SELECT * FROM ${table}`;
    if (keys.length) sql += " WHERE " + keys.map((k, i) => `${k}=$${i + 1}`).join(" AND ");
    if (order) sql += ` ORDER BY ${order}`;
    return this.db.prepare(sql).all(...keys.map((k) => where[k]));
  }
  async _delete(table, id) {
    await this.db.prepare(`DELETE FROM ${table} WHERE id=$1`).run(id);
    return { id };
  }
  async _insertRow(table, cols, vals) {
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`;
    await this.db.prepare(sql).run(...vals);
  }
  // 仅插入调用方提供的列（未提供的列回落到列默认值）
  async _create(table, data, allowed) {
    return this._serial(async () => {
      const id = data.id != null ? data.id : await this._nextId(table);
      const cols = ["id"]; const vals = [id];
      for (const c of allowed) {
        if (data[c] !== undefined) { cols.push(c); vals.push(data[c]); }
      }
      await this._insertRow(table, cols, vals);
      return this._get(table, id);
    });
  }
  // 仅更新白名单内的列，并刷新 updated_at
  async _update(table, id, data, allowed) {
    const cols = allowed.filter((c) => data[c] !== undefined);
    if (!cols.length) return this._get(table, id);
    const sql = `UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(", ")}, updated_at=now() WHERE id=$${cols.length + 1}`;
    await this.db.prepare(sql).run(...cols.map((c) => data[c]), id);
    return this._get(table, id);
  }

  // ================= 工作区 / 会话树 =================
  listWorkspaces() { return this._list("workspaces", {}, "updated_at DESC"); }
  getWorkspace({ id }) { return this._get("workspaces", id); }
  createWorkspace(data) { return this._create("workspaces", data, ["folder_path", "folder_name"]); }
  updateWorkspace({ id, ...d }) { return this._update("workspaces", id, d, ["folder_path", "folder_name"]); }
  async deleteWorkspace({ id }) {
    const sessions = await this._list("sessions", { workspace_id: id });
    for (const s of sessions) await this.deleteSession({ id: s.id, hard: true });
    return this._delete("workspaces", id);
  }

  listSessions({ workspace_id, includeDeleted } = {}) {
    let sql = "SELECT * FROM sessions WHERE 1=1";
    const params = [];
    let i = 0;
    if (!includeDeleted) { sql += " AND deleted_at IS NULL"; }
    if (workspace_id != null) { sql += ` AND workspace_id=$${++i}`; params.push(workspace_id); }
    sql += " ORDER BY updated_at DESC";
    return this.db.prepare(sql).all(...params);
  }
  getSession({ id }) { return this._get("sessions", id); }
  createSession(data) { return this._create("sessions", data, ["workspace_id", "kind", "name", "description", "activity"]); }
  updateSession({ id, ...d }) { return this._update("sessions", id, d, ["name", "description", "activity"]); }
  async deleteSession({ id, hard } = {}) {
    if (hard) {
      // 工作区级删除：级联清 turns 后硬删
      const turns = await this._list("turns", { session_id: id });
      for (const t of turns) await this.deleteTurn({ id: t.id });
      // 手工清理子代理委派记录（作为子会话或被委派方）。关联行里指向本会话
      // 消息的 prompt/settle 随上面的 deleteMessage 已清；这里只补 subagents 本身。
      await this.db.prepare("DELETE FROM subagents WHERE sub_sess_id=$1 OR par_sess_id=$1").run(id);
      return this._delete("sessions", id);
    }
    // 默认软删除：标记 deleted_at，保留 turns 供回溯恢复
    return this._update("sessions", id, { deleted_at: "now" }, ["deleted_at"]);
  }
  async restoreSession({ id }) {
    return this._update("sessions", id, { deleted_at: null }, ["deleted_at"]);
  }

  // ================= 压缩（DSH 事件日志格式） =================
  // seq 与 messages.surface_seq 共用同一个 per-session 序列：
  //   compaction/start -> compaction/summary -> user/message(surfaceOp:replace) -> compaction/end
  // 锁 = 同一 boot 内未闭合的 compaction/start；进程重启后旧 start 自动失效。
  _mapEvent(row) {
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      seq: Number(row.seq),
      type: row.type,
      data: _j(row.data) || {},
      boot: row.boot,
      createdAt: row.created_at,
    };
  }
  async _nextSessionSeq(sessionId) {
    const row = await this.db.prepare("SELECT next_seq FROM sessions WHERE id=$1").get(sessionId);
    const next = Number(row && row.next_seq != null ? row.next_seq : 0) + 1;
    await this.db.prepare("UPDATE sessions SET next_seq=$1 WHERE id=$2").run(next, sessionId);
    return next;
  }
  async appendSessionEvent({ session_id, type, data, boot }) {
    return this._serial(async () => {
      const seq = await this._nextSessionSeq(session_id);
      const id = await this._nextId("session_events");
      await this._insertRow("session_events", ["id", "session_id", "seq", "type", "data", "boot"], [
        id, session_id, seq, type, JSON.stringify(data || {}), boot || null,
      ]);
      return this._mapEvent(await this._get("session_events", id));
    });
  }
  async listSessionEvents({ session_id }) {
    const rows = await this.db.prepare(
      "SELECT * FROM session_events WHERE session_id=$1 ORDER BY seq"
    ).all(session_id);
    return rows.map((r) => this._mapEvent(r));
  }
  // The lock is the newest compaction start/end marker: a trailing start means
  // the bracket is still open. A start recorded by an earlier process boot is
  // stale (DSH's session/end-seed boundary).
  async getActiveCompaction({ session_id, boot }) {
    const latest = await this.db.prepare(
      "SELECT * FROM session_events WHERE session_id=$1 AND type IN ('compaction/start','compaction/end') ORDER BY seq DESC LIMIT 1"
    ).get(session_id);
    if (!latest || latest.type !== "compaction/start") return null;
    if (boot != null && latest.boot !== boot) return null;
    return {
      id: Number(latest.seq),
      sessionId: session_id,
      status: "started",
      trigger: (_j(latest.data) || {}).trigger || "manual",
      createdAt: latest.created_at,
    };
  }
  // UI / trajectory view of successful compactions: the summary events.
  _mapCompactionSummary(event) {
    const data = event.data || {};
    return {
      id: event.seq,
      sessionId: event.sessionId,
      status: "succeeded",
      trigger: data.trigger || "manual",
      upToMessageId: data.boundaryMessageId == null ? null : Number(data.boundaryMessageId),
      upToTurnSeq: data.boundaryTurnSeq == null ? null : Number(data.boundaryTurnSeq),
      turns: data.turns == null ? null : Number(data.turns),
      summary: data.summary,
      provider: data.provider,
      model: data.model,
      tokensBefore: data.shadowedTokenCount == null ? null : Number(data.shadowedTokenCount),
      tokensAfter: data.tokensAfter == null ? null : Number(data.tokensAfter),
      shadowedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [],
      shadowedRange: data.shadowedRange || null,
      error: null,
      createdAt: event.createdAt,
    };
  }
  async listCompactions({ session_id }) {
    const rows = await this.db.prepare(
      "SELECT * FROM session_events WHERE session_id=$1 AND type='compaction/summary' ORDER BY seq"
    ).all(session_id);
    return rows.map((r) => this._mapCompactionSummary(this._mapEvent(r)));
  }

  // ---- tool-result pruner（模型无关的确定性裁剪，原始消息不动）----
  async listToolMessages({ session_id }) {
    return this.db.prepare(
      "SELECT t.seq AS turn_seq, m.id AS message_id, c.content AS content FROM turns t JOIN steps s ON s.turn_id=t.id JOIN messages m ON m.step_id=s.id LEFT JOIN contents c ON c.id=m.content_id WHERE t.session_id=$1 AND m.role='tool' ORDER BY t.seq, s.seq, m.seq"
    ).all(session_id);
  }
  async saveToolResultPrune({ message_id, content, chars_before, chars_after }) {
    await this.db.prepare("DELETE FROM tool_result_prunes WHERE message_id=$1").run(message_id);
    await this.db.prepare(
      "INSERT INTO tool_result_prunes (message_id, content, chars_before, chars_after) VALUES ($1,$2,$3,$4)"
    ).run(message_id, content, chars_before, chars_after);
    return { message_id };
  }

  // 消息投影（含 per-session surface_seq）。原始消息永不改写；tool 结果用
  // pruned 替换体，assistant 的 tool_calls 从 calls 表还原并按步配对 call_id。
  async _projectMessages({ session_id }) {
    const rows = await this.db.prepare(
      'SELECT t.id AS turn_id, t.seq AS turn_seq, s.id AS step_id, s.seq AS step_seq, m.id AS message_id, m.seq AS msg_seq, m.surface_seq, m.role, c.content AS content, p.content AS pruned FROM turns t JOIN steps s ON s.turn_id=t.id JOIN messages m ON m.step_id=s.id LEFT JOIN contents c ON c.id=m.content_id LEFT JOIN tool_result_prunes p ON p.message_id=m.id WHERE t.session_id=$1 ORDER BY t.seq, s.seq, m.seq'
    ).all(session_id);
    const callRows = await this.db.prepare(
      'SELECT c.id, c.reply_id, c.seq, c.call_id, c.name, c."arguments" FROM calls c JOIN messages m ON m.id=c.reply_id JOIN steps s ON s.id=m.step_id JOIN turns t ON t.id=s.turn_id WHERE t.session_id=$1 ORDER BY c.reply_id, c.seq'
    ).all(session_id);
    const callsByReply = new Map();
    for (const c of callRows) {
      if (!callsByReply.has(c.reply_id)) callsByReply.set(c.reply_id, []);
      callsByReply.get(c.reply_id).push(c);
    }
    const messages = [];
    let stepId = null;
    let pendingCallIds = [];
    for (const r of rows) {
      if (r.step_id !== stepId) { stepId = r.step_id; pendingCallIds = []; }
      if (r.role === "system") {
        messages.push({ id: r.message_id, surfaceSeq: Number(r.surface_seq), turnSeq: r.turn_seq, role: "system", content: r.content == null ? "" : r.content });
        continue;
      }
      if (r.role === "user") {
        messages.push({ id: r.message_id, surfaceSeq: Number(r.surface_seq), turnSeq: r.turn_seq, role: "user", content: r.content == null ? "" : r.content });
      } else if (r.role === "assistant") {
        const msg = { id: r.message_id, surfaceSeq: Number(r.surface_seq), turnSeq: r.turn_seq, role: "assistant", content: r.content == null ? "" : r.content };
        const calls = callsByReply.get(r.message_id) || [];
        if (calls.length) {
          pendingCallIds = calls.map((c) => String(c.call_id != null ? c.call_id : c.id));
          msg.tool_calls = calls.map((c) => ({
            id: String(c.call_id != null ? c.call_id : c.id),
            type: "function",
            function: { name: c.name, arguments: c.arguments == null ? "{}" : String(c.arguments) },
          }));
        }
        messages.push(msg);
      } else if (r.role === "tool") {
        const toolCallId = pendingCallIds.length ? pendingCallIds.shift() : "";
        messages.push({
          id: r.message_id,
          surfaceSeq: Number(r.surface_seq),
          turnSeq: r.turn_seq,
          role: "tool",
          tool_call_id: toolCallId,
          content: r.pruned != null ? r.pruned : (r.content == null ? "" : r.content),
        });
      }
    }
    return messages;
  }

  // Surface replay (DSH): append-origin messages with every compaction
  // `user/message` replace applied in seq order. Nodes keep their event seq, so
  // shadowedSeqs / surfaceOp ranges are real sequence numbers.
  async getSurface({ session_id }) {
    const messages = await this._projectMessages({ session_id });
    const events = await this.listSessionEvents({ session_id });
    const nodes = messages
      .filter((m) => m.role !== "system")
      .sort((a, b) => a.surfaceSeq - b.surfaceSeq)
      .map((m) => ({
        seq: m.surfaceSeq,
        kind: "message",
        id: m.id,
        turnSeq: m.turnSeq == null ? null : Number(m.turnSeq),
        message: Object.assign(
          { role: m.role, content: m.content },
          m.tool_calls ? { tool_calls: m.tool_calls } : {},
          m.tool_call_id ? { tool_call_id: m.tool_call_id } : {},
        ),
      }));
    for (const event of events) {
      if (event.type !== "user/message") continue;
      const data = event.data || {};
      const op = data.surfaceOp;
      if (!op || op.op !== "replace") continue;
      const startIdx = nodes.findIndex((node) => node.seq === op.start);
      const endIdx = nodes.findIndex((node) => node.seq === op.end);
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue;
      nodes.splice(startIdx, endIdx - startIdx + 1, {
        seq: event.seq,
        kind: "checkpoint",
        id: null,
        turnSeq: data.boundaryTurnSeq == null ? null : Number(data.boundaryTurnSeq),
        compactionId: data.source && data.source.compactionId,
        message: { role: "user", content: data.content == null ? "" : data.content },
      });
    }
    return { nodes, events };
  }

  // Convenience projection for tests/tools: flat surface messages + latest
  // successful compaction summary.
  async getSessionHistory({ session_id }) {
    const surface = await this.getSurface({ session_id });
    const compactions = await this.listCompactions({ session_id });
    return {
      messages: surface.nodes.map((node) => Object.assign(
        { id: node.kind === "checkpoint" ? node.seq : node.id, turnSeq: node.turnSeq, checkpoint: node.kind === "checkpoint" },
        node.message,
      )),
      compaction: compactions.length ? compactions[compactions.length - 1] : null,
    };
  }

  // ---- token-meter usage anchor ----
  _mapAnchor(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id,
      headerKey: row.header_key,
      headerTokens: Number(row.header_tokens),
      inputTokens: Number(row.input_tokens),
      assistantTokens: Number(row.assistant_tokens),
      usageTotal: Number(row.usage_total),
    };
  }
  async getTokenAnchor({ session_id }) {
    const row = await this.db.prepare("SELECT * FROM token_anchors WHERE session_id=$1").get(session_id);
    return this._mapAnchor(row);
  }
  async saveTokenAnchor({ session_id, header_key, header_tokens, input_tokens, assistant_tokens, usage_total }) {
    await this.db.prepare("DELETE FROM token_anchors WHERE session_id=$1").run(session_id);
    await this.db.prepare(
      "INSERT INTO token_anchors (session_id, header_key, header_tokens, input_tokens, assistant_tokens, usage_total) VALUES ($1,$2,$3,$4,$5,$6)"
    ).run(session_id, header_key, header_tokens, input_tokens, assistant_tokens, usage_total);
    return this.getTokenAnchor({ session_id });
  }

  // ---- goals（每个 session 一个当前 goal，revision 做 CAS）----
  _mapGoal(row) {
    if (!row) return null;
    return {
      id: row.goal_id,
      revision: Number(row.revision),
      objective: row.objective,
      phase: row.phase,
      roundsStarted: Number(row.rounds_started),
      maxGoalRounds: Number(row.max_goal_rounds),
      ...(row.blocked_code ? { blockedReason: { code: row.blocked_code, message: row.blocked_message || "" } } : {}),
      activation: row.activation,
    };
  }
  async getGoal({ session_id }) {
    const row = await this.db.prepare("SELECT * FROM goals WHERE session_id=$1").get(session_id);
    return this._mapGoal(row);
  }
  async saveGoal({ session_id, goal }) {
    await this.db.prepare("DELETE FROM goals WHERE session_id=$1").run(session_id);
    await this._insertRow("goals", [
      "session_id", "goal_id", "revision", "objective", "phase",
      "rounds_started", "max_goal_rounds", "blocked_code", "blocked_message", "activation",
    ], [
      session_id, goal.id, goal.revision, goal.objective, goal.phase,
      goal.roundsStarted || 0, goal.maxGoalRounds, goal.blockedReason ? goal.blockedReason.code : null,
      goal.blockedReason ? goal.blockedReason.message : null, goal.activation || "armed",
    ]);
    return this.getGoal({ session_id });
  }

  // ---- user jobs（模型派给真人用户的任务；status: pending|completed|killed）----
  _mapUserJob(row) {
    if (!row) return null;
    return {
      jobId: row.job_id,
      sessionId: row.session_id,
      status: row.status,
      description: row.description,
      title: row.title,
      result: row.result,
    };
  }
  async createUserJob({ job_id, session_id, status = "pending", description, title }) {
    return this._serial(async () => {
      const id = await this._nextId("user_jobs");
      await this._insertRow("user_jobs", ["id", "job_id", "session_id", "status", "description", "title"], [id, job_id, session_id, status, description, title || null]);
      return this._mapUserJob(await this.db.prepare("SELECT * FROM user_jobs WHERE job_id=$1").get(job_id));
    });
  }
  async getUserJob({ job_id }) {
    const row = await this.db.prepare("SELECT * FROM user_jobs WHERE job_id=$1").get(job_id);
    return this._mapUserJob(row);
  }
  async listUserJobs({ session_id }) {
    const rows = await this.db.prepare("SELECT * FROM user_jobs WHERE session_id=$1 ORDER BY created_at DESC").all(session_id);
    return rows.map((r) => this._mapUserJob(r));
  }
  async completeUserJob({ job_id, result }) {
    await this.db.prepare("UPDATE user_jobs SET status='completed', result=$1, updated_at=now() WHERE job_id=$2").run(result || null, job_id);
    return this._mapUserJob(await this.db.prepare("SELECT * FROM user_jobs WHERE job_id=$1").get(job_id));
  }
  async killUserJob({ job_id }) {
    await this.db.prepare("UPDATE user_jobs SET status='killed', updated_at=now() WHERE job_id=$1").run(job_id);
    return this._mapUserJob(await this.db.prepare("SELECT * FROM user_jobs WHERE job_id=$1").get(job_id));
  }

  listTurns({ session_id }) { return this._list("turns", { session_id }, "seq"); }
  getTurn({ id }) { return this._get("turns", id); }
  createTurn(data) { return this._create("turns", data, ["session_id", "seq", "status"]); }
  updateTurn({ id, ...d }) { return this._update("turns", id, d, ["status"]); }
  async deleteTurn({ id }) {
    const steps = await this._list("steps", { turn_id: id });
    for (const s of steps) await this.deleteStep({ id: s.id });
    return this._delete("turns", id);
  }

  listSteps({ turn_id }) { return this._list("steps", { turn_id }, "seq"); }
  getStep({ id }) { return this._get("steps", id); }
  createStep(data) { return this._create("steps", data, ["turn_id", "seq", "status"]); }
  updateStep({ id, ...d }) { return this._update("steps", id, d, ["status"]); }
  async deleteStep({ id }) {
    const msgs = await this._list("messages", { step_id: id });
    for (const m of msgs) await this.deleteMessage({ id: m.id });
    return this._delete("steps", id);
  }

  // ---- contents ----
  addContent(data) { return this._create("contents", data, ["content"]); }
  getContent({ id }) { return this._get("contents", id); }

  // ---- messages（content 与 thought 分别存于 contents，经 content_id / thought_id 关联）----
  async addMessage({ step_id, seq, role, content, thought, session_id, source }) {
    return this._serial(async () => {
      // surface_seq 与 session_events.seq 共用一个 per-session 序列；调用方通常
      // 直接传 session_id，测试/旧调用则从 step -> turn 反查。
      let sid = session_id;
      if (sid == null) {
        const owner = await this.db.prepare(
          "SELECT t.session_id FROM steps s JOIN turns t ON t.id=s.turn_id WHERE s.id=$1"
        ).get(step_id);
        sid = owner ? owner.session_id : null;
      }
      const surfaceSeq = sid != null ? await this._nextSessionSeq(sid) : 0;
      // content_id / thought_id 可空：仅当对应内容存在时才建 contents 行
      let content_id = null;
      if (content != null) {
        content_id = await this._nextId("contents");
        await this._insertRow("contents", ["id", "content"], [content_id, content]);
      }
      let thought_id = null;
      if (thought != null) {
        thought_id = await this._nextId("contents");
        await this._insertRow("contents", ["id", "content"], [thought_id, thought]);
      }
      const id = await this._nextId("messages");
      const cols = ["id", "step_id", "seq", "surface_seq", "role", "content_id", "thought_id"];
      const vals = [id, step_id, seq, surfaceSeq, role, content_id, thought_id];
      if (source != null) { cols.push("source"); vals.push(source); }
      await this._insertRow("messages", cols, vals);
      return this.getMessage({ id });
    });
  }
  async getMessage({ id }) {
    return this.db.prepare(
      "SELECT messages.id, messages.step_id, messages.seq, messages.role, messages.source, messages.content_id, messages.thought_id, contents.content, thought_content.content AS thought, messages.created_at, messages.updated_at FROM messages LEFT JOIN contents ON contents.id=messages.content_id LEFT JOIN contents thought_content ON thought_content.id=messages.thought_id WHERE messages.id=$1"
    ).get(id);
  }
  async listMessages({ step_id }) {
    return this.db.prepare(
      "SELECT messages.id, messages.step_id, messages.seq, messages.role, messages.source, messages.content_id, messages.thought_id, contents.content, thought_content.content AS thought, messages.created_at, messages.updated_at FROM messages LEFT JOIN contents ON contents.id=messages.content_id LEFT JOIN contents thought_content ON thought_content.id=messages.thought_id WHERE messages.step_id=$1 ORDER BY messages.seq"
    ).all(step_id);
  }
  // 会话级 system prompt：返回该 session 最早落库的 system 消息内容。
  // 每轮都会复制一份同样的内容，因此取任意一份都相同；按 turn/step/message 顺序取最早。
  async getSessionPrompt({ session_id }) {
    const row = await this.db.prepare(
      "SELECT contents.content FROM turns JOIN steps ON steps.turn_id=turns.id JOIN messages ON messages.step_id=steps.id JOIN contents ON contents.id=messages.content_id WHERE turns.session_id=$1 AND messages.role='system' ORDER BY turns.seq ASC, steps.seq ASC, messages.seq ASC LIMIT 1"
    ).get(session_id);
    return row ? row.content : null;
  }
  // 轨迹面板：返回 turns -> steps -> (messages + calls) 的树，供前端时间线渲染。
  // 复用现有 list* 方法，不新增采集逻辑。
  async getTrajectory({ session_id }) {
    const turns = await this.listTurns({ session_id });
    const out = [];
    for (const turn of turns) {
      const steps = await this.listSteps({ turn_id: turn.id });
      const stepOut = [];
      for (const step of steps) {
        const messages = await this.listMessages({ step_id: step.id });
        const calls = [];
        for (const m of messages) {
          const cs = await this.db.prepare(
            "SELECT id, call_id, name, arguments, description, status, result_id, error, category FROM calls WHERE reply_id=$1 ORDER BY seq"
          ).all(m.id);
          for (const c of cs) {
            let result = null;
            if (c.result_id != null) {
              const rc = await this.db.prepare("SELECT content FROM contents WHERE id=$1").get(c.result_id);
              result = rc ? rc.content : null;
            }
            calls.push({
              id: c.id, call_id: c.call_id, name: c.name, arguments: c.arguments,
              description: c.description, status: c.status, result, error: c.error, category: c.category,
            });
          }
        }
        stepOut.push({ id: step.id, seq: step.seq, status: step.status, messages, calls });
      }
      out.push({ id: turn.id, seq: turn.seq, status: turn.status, steps: stepOut });
    }
    return out;
  }
  async deleteMessage({ id }) {
    const msg = await this._get("messages", id);
    if (!msg) return;
    const callsToDel = await this.db.prepare("SELECT id, result_id FROM calls WHERE reply_id=$1").all(msg.id);
    // 手工清理子代理关联行（pg-micro 不强制 FK，ON DELETE CASCADE 为空文）。
    // 该消息可能是委派 tool_call 的宿主、子会话首条 prompt、或结算/输出消息。
    for (const c of callsToDel) {
      await this.db.prepare("DELETE FROM subagent_prompts WHERE call_id=$1").run(c.id);
    }
    await this.db.prepare("DELETE FROM subagent_prompts WHERE prompt_id=$1").run(msg.id);
    await this.db.prepare("DELETE FROM subagent_settles WHERE output_id=$1 OR settle_id=$1").run(msg.id);
    for (const c of callsToDel) if (c.result_id != null) await this._delete("contents", c.result_id);
    await this.db.prepare("DELETE FROM calls WHERE reply_id=$1").run(msg.id);
    if (msg.thought_id != null) await this._delete("contents", msg.thought_id);
    await this._delete("messages", id);
    if (msg.content_id != null) return this._delete("contents", msg.content_id);
  }

  // ---- calls（工具调用，arguments 为 text 原文；result 存于 contents）----
  async addCall(payload) {
    return this._serial(() => this._addCallUnlocked(payload));
  }
  async _addCallUnlocked({ reply_id, seq, name, description, arguments: args, status, category, call_id, result, error, id }) {
    let result_id = null;
    if (result !== undefined && result !== null) {
      result_id = await this._nextId("contents");
      const rc = typeof result === "string" ? result : JSON.stringify(result);
      await this._insertRow("contents", ["id", "content"], [result_id, rc]);
    }
    const cid = id != null ? id : await this._nextId("calls");
    const argJson = args && typeof args === "object" ? JSON.stringify(args) : (args || "{}");
    const cols = ["id", "reply_id", "seq", "name"]; const vals = [cid, reply_id, seq, name];
    if (call_id !== undefined && call_id !== null) { cols.push("call_id"); vals.push(String(call_id)); }
    if (description !== undefined) { cols.push("description"); vals.push(description); }
    cols.push('"arguments"'); vals.push(argJson);
    if (status !== undefined) { cols.push("status"); vals.push(status); }
    if (result_id !== null) { cols.push("result_id"); vals.push(result_id); }
    if (error !== undefined) { cols.push("error"); vals.push(error); }
    cols.push("category"); vals.push(category || "unknown");
    await this._insertRow("calls", cols, vals);
    return this.getCall({ id: cid });
  }
  _callRow(row) { if (row) row.arguments = _j(row.arguments); return row; }
  async getCall({ id }) {
    const row = await this.db.prepare(
      'SELECT id, reply_id, seq, call_id, name, description, "arguments", status, result_id, error, category, created_at, updated_at FROM calls WHERE id=$1'
    ).get(id);
    return this._callRow(row);
  }
  async listCallsByReply({ reply_id }) {
    const rows = await this.db.prepare(
      'SELECT id, reply_id, seq, call_id, name, description, "arguments", status, result_id, error, category, created_at, updated_at FROM calls WHERE reply_id=$1 ORDER BY seq'
    ).all(reply_id);
    return rows.map((r) => this._callRow(r));
  }
  async updateCall({ id, status, error, result }) {
    return this._serial(async () => {
      let result_id;
      if (result !== undefined) {
        result_id = await this._nextId("contents");
        const rc = typeof result === "string" ? result : JSON.stringify(result);
        await this._insertRow("contents", ["id", "content"], [result_id, rc]);
      }
      const sets = []; const vals = []; let i = 1;
      if (status !== undefined) { sets.push(`status=$${i++}`); vals.push(status); }
      if (error !== undefined) { sets.push(`error=$${i++}`); vals.push(error); }
      if (result_id !== undefined && result_id !== null) { sets.push(`result_id=$${i++}`); vals.push(result_id); }
      if (sets.length) {
        sets.push("updated_at=now()"); vals.push(id);
        await this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id=$${i}`).run(...vals);
      }
      return this.getCall({ id });
    });
  }
  async deleteCall({ id }) {
    const call = await this._get("calls", id);
    if (call && call.result_id != null) await this._delete("contents", call.result_id);
    return this._delete("calls", id);
  }

  // ================= 注册表：供应者 / 模型 / 工具 / 技能 / 配置 =================
  // DEPRECATED: 供应者/模型现已改由 user/providers.json 承载（见 core/index.js 的 case "providers"，
  // 由 ui/web/models.js 读写）。以下 provider.* / model.* 方法仅保留以兼容旧 store.db 数据，
  // 运行时不再使用，后续可整体删除。
  listProviders() { return this._list("providers"); }
  createProvider(data) { return this._create("providers", data, ["name", "description", "baseurl", "apikey"]); }
  updateProvider({ id, ...d }) { return this._update("providers", id, d, ["name", "description", "baseurl", "apikey"]); }
  async deleteProvider({ id }) {
    const models = await this._list("models", { provider_id: id });
    for (const m of models) await this.deleteModel({ id: m.id });
    return this._delete("providers", id);
  }

  // DEPRECATED: 见上方 provider.* 说明。
  listModels({ provider_id } = {}) { return this._list("models", provider_id != null ? { provider_id } : {}); }
  createModel(data) { return this._create("models", data, ["provider_id", "name", "description", "fee"]); }
  updateModel({ id, ...d }) { return this._update("models", id, d, ["provider_id", "name", "description", "fee"]); }
  async deleteModel({ id }) {
    return this._delete("models", id);
  }

  listTools() { return this._list("tools"); }
  createTool(data) { return this._create("tools", data, ["name", "description", "schema_json", "path"]); }
  updateTool({ id, ...d }) { return this._update("tools", id, d, ["name", "description", "schema_json", "path"]); }
  async deleteTool({ id }) {
    await this.db.prepare("DELETE FROM tool_skills WHERE tool_id=$1").run(id);
    return this._delete("tools", id);
  }

  listSkills() { return this._list("skills"); }
  createSkill(data) { return this._create("skills", data, ["name", "description", "prompt", "path"]); }
  updateSkill({ id, ...d }) { return this._update("skills", id, d, ["name", "description", "prompt", "path"]); }
  async deleteSkill({ id }) {
    await this.db.prepare("DELETE FROM tool_skills WHERE skill_id=$1").run(id);
    return this._delete("skills", id);
  }


  // ================= 子代理关联表（无 id 列，走裸 SQL / _insertRow）=================
  async addSubagent({ sub_sess_id, par_sess_id }) {
    await this._insertRow("subagents", ["sub_sess_id", "par_sess_id"], [sub_sess_id, par_sess_id]);
    return this.getSubagent({ sub_sess_id });
  }
  getSubagent({ sub_sess_id }) {
    return this.db.prepare("SELECT * FROM subagents WHERE sub_sess_id=$1").get(sub_sess_id);
  }
  listSubagents({ par_sess_id }) {
    return this.db.prepare("SELECT * FROM subagents WHERE par_sess_id=$1").all(par_sess_id);
  }
  markSubagentDiscarded({ sub_sess_id }) {
    return this.db.prepare("UPDATE subagents SET discarded_at=now() WHERE sub_sess_id=$1").run(sub_sess_id);
  }
  async addSubagentPrompt({ call_id, prompt_id }) {
    await this._insertRow("subagent_prompts", ["call_id", "prompt_id"], [call_id, prompt_id]);
    return { call_id, prompt_id };
  }
  getSubagentPrompt({ call_id }) {
    return this.db.prepare("SELECT * FROM subagent_prompts WHERE call_id=$1").get(call_id);
  }
  async addSubagentSettle({ output_id, settle_id }) {
    await this._insertRow("subagent_settles", ["output_id", "settle_id"], [output_id, settle_id]);
    return { output_id, settle_id };
  }
  getSubagentSettle({ settle_id }) {
    return this.db.prepare("SELECT * FROM subagent_settles WHERE settle_id=$1").get(settle_id);
  }
  // 反查：给定父会话结算消息 id，找出产生它的子会话 id。
  // 分步查（pg-micro 不支持 JOIN ON 里引用外层别名的标量子查询）：
  // settle_id -> output_id -> 子会话 session_id -> subagents 行。
  async getSubagentBySettle({ settle_id }) {
    const link = await this.db.prepare("SELECT output_id FROM subagent_settles WHERE settle_id=$1").get(settle_id);
    if (!link || link.output_id == null) return undefined;
    const owner = await this.db.prepare(
      "SELECT t.session_id FROM messages m JOIN steps s ON s.id=m.step_id JOIN turns t ON t.id=s.turn_id WHERE m.id=$1"
    ).get(link.output_id);
    if (!owner) return undefined;
    return this.db.prepare("SELECT * FROM subagents WHERE sub_sess_id=$1").get(owner.session_id);
  }

  // ================= 关联表 =================
  async linkToolSkill({ tool_id, skill_id }) {
    try { await this.db.prepare("INSERT INTO tool_skills (tool_id, skill_id) VALUES ($1,$2)").run(tool_id, skill_id); }
    catch (e) { if (!/unique/i.test(String(e.message))) throw e; }
    return { tool_id, skill_id };
  }
  unlinkToolSkill({ tool_id, skill_id }) { return this.db.prepare("DELETE FROM tool_skills WHERE tool_id=$1 AND skill_id=$2").run(tool_id, skill_id); }
  listSkillsForTool({ tool_id }) { return this.db.prepare("SELECT skills.id, skills.name, skills.description, skills.prompt, skills.path, skills.created_at, skills.updated_at FROM skills JOIN tool_skills ON tool_skills.skill_id=skills.id WHERE tool_skills.tool_id=$1").all(tool_id); }
  listToolsForSkill({ skill_id }) { return this.db.prepare("SELECT tools.id, tools.name, tools.description, tools.schema_json, tools.path, tools.created_at, tools.updated_at FROM tools JOIN tool_skills ON tool_skills.tool_id=tools.id WHERE tool_skills.skill_id=$1").all(skill_id); }


  // ================= 供 handleCall 调用的操作分发 =================
  async run(op, p = {}) {
    const fn = OPS[op];
    if (typeof fn !== "function") throw new Error("unknown storage op: " + op);
    return fn(this, p);
  }
}

// op 映射表：fn(store, payload) => result
const OPS = {
  "workspace.list": (s) => s.listWorkspaces(),
  "workspace.get": (s, p) => s.getWorkspace(p),
  "workspace.create": (s, p) => s.createWorkspace(p),
  "workspace.update": (s, p) => s.updateWorkspace(p),
  "workspace.delete": (s, p) => s.deleteWorkspace(p),

  "session.list": (s, p) => s.listSessions(p),
  "session.get": (s, p) => s.getSession(p),
  "session.create": (s, p) => s.createSession(p),
  "session.update": (s, p) => s.updateSession(p),
  "session.delete": (s, p) => s.deleteSession(p),
  "session.restore": (s, p) => s.restoreSession(p),
  "session.prompt": (s, p) => s.getSessionPrompt(p),
  "session.trajectory": (s, p) => s.getTrajectory(p),
  "session.history": (s, p) => s.getSessionHistory(p),
  "session.surface": (s, p) => s.getSurface(p),
  "session.events": (s, p) => s.listSessionEvents(p),
  "session.compactions": (s, p) => s.listCompactions(p),

  "compaction.append": (s, p) => s.appendSessionEvent(p),
  "compaction.active": (s, p) => s.getActiveCompaction(p),

  "toolResultPrune.list": (s, p) => s.listToolMessages(p),
  "toolResultPrune.save": (s, p) => s.saveToolResultPrune(p),

  "tokenAnchor.get": (s, p) => s.getTokenAnchor(p),
  "tokenAnchor.save": (s, p) => s.saveTokenAnchor(p),

  "goal.get": (s, p) => s.getGoal(p),
  "goal.save": (s, p) => s.saveGoal(p),

  "userJob.create": (s, p) => s.createUserJob(p),
  "userJob.get": (s, p) => s.getUserJob(p),
  "userJob.list": (s, p) => s.listUserJobs(p),
  "userJob.complete": (s, p) => s.completeUserJob(p),
  "userJob.kill": (s, p) => s.killUserJob(p),

  "subagent.add": (s, p) => s.addSubagent(p),
  "subagent.get": (s, p) => s.getSubagent(p),
  "subagent.list": (s, p) => s.listSubagents(p),
  "subagent.discard": (s, p) => s.markSubagentDiscarded(p),
  "subagent.bySettle": (s, p) => s.getSubagentBySettle(p),
  "subagentPrompt.add": (s, p) => s.addSubagentPrompt(p),
  "subagentPrompt.get": (s, p) => s.getSubagentPrompt(p),
  "subagentSettle.add": (s, p) => s.addSubagentSettle(p),
  "subagentSettle.get": (s, p) => s.getSubagentSettle(p),

  "turn.list": (s, p) => s.listTurns(p),
  "turn.get": (s, p) => s.getTurn(p),
  "turn.create": (s, p) => s.createTurn(p),
  "turn.update": (s, p) => s.updateTurn(p),
  "turn.delete": (s, p) => s.deleteTurn(p),

  "step.list": (s, p) => s.listSteps(p),
  "step.get": (s, p) => s.getStep(p),
  "step.create": (s, p) => s.createStep(p),
  "step.update": (s, p) => s.updateStep(p),
  "step.delete": (s, p) => s.deleteStep(p),

  "content.add": (s, p) => s.addContent(p),
  "content.get": (s, p) => s.getContent(p),

  "message.add": (s, p) => s.addMessage(p),
  "message.list": (s, p) => s.listMessages(p),
  "message.get": (s, p) => s.getMessage(p),
  "message.delete": (s, p) => s.deleteMessage(p),

  "call.add": (s, p) => s.addCall(p),
  "call.list": (s, p) => s.listCallsByReply(p),
  "call.get": (s, p) => s.getCall(p),
  "call.update": (s, p) => s.updateCall(p),
  "call.delete": (s, p) => s.deleteCall(p),

  // DEPRECATED: 供应者/模型 OPS 已由 core/index.js 的 case "providers"（读写 user/providers.json）取代，
  // ui/web/models.js 不再调用以下 op。仅保留以兼容旧 store.db，后续可删除。
  "provider.list": (s) => s.listProviders(),
  "provider.get": (s, p) => s._get("providers", p.id),
  "provider.create": (s, p) => s.createProvider(p),
  "provider.update": (s, p) => s.updateProvider(p),
  "provider.delete": (s, p) => s.deleteProvider(p),

  "model.list": (s, p) => s.listModels(p),
  "model.get": (s, p) => s._get("models", p.id),
  "model.create": (s, p) => s.createModel(p),
  "model.update": (s, p) => s.updateModel(p),
  "model.delete": (s, p) => s.deleteModel(p),

  "tool.list": (s) => s.listTools(),
  "tool.get": (s, p) => s._get("tools", p.id),
  "tool.create": (s, p) => s.createTool(p),
  "tool.update": (s, p) => s.updateTool(p),
  "tool.delete": (s, p) => s.deleteTool(p),

  "skill.list": (s) => s.listSkills(),
  "skill.get": (s, p) => s._get("skills", p.id),
  "skill.create": (s, p) => s.createSkill(p),
  "skill.update": (s, p) => s.updateSkill(p),
  "skill.delete": (s, p) => s.deleteSkill(p),


  "toolSkill.link": (s, p) => s.linkToolSkill(p),
  "toolSkill.unlink": (s, p) => s.unlinkToolSkill(p),
  "toolSkill.listSkills": (s, p) => s.listSkillsForTool(p),
  "toolSkill.listTools": (s, p) => s.listToolsForSkill(p),

};

export async function createStore(options = {}) {
  const rawPath = options.path || process.env.STORE_PATH || "./data/store.db";
  const dbPath = resolve(process.cwd(), rawPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = await connect(dbPath);
  const store = new Store(db);
  await store._execSchema();
  return store;
}

export { Store };
