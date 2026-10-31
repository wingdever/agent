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
  constructor(db) { this.db = db; }

  async close() { await this.db.close(); }

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
    const id = data.id != null ? data.id : await this._nextId(table);
    const cols = ["id"]; const vals = [id];
    for (const c of allowed) {
      if (data[c] !== undefined) { cols.push(c); vals.push(data[c]); }
    }
    await this._insertRow(table, cols, vals);
    return this._get(table, id);
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
    for (const s of sessions) await this.deleteSession({ id: s.id });
    return this._delete("workspaces", id);
  }

  listSessions({ workspace_id } = {}) { return this._list("sessions", workspace_id != null ? { workspace_id } : {}, "updated_at DESC"); }
  getSession({ id }) { return this._get("sessions", id); }
  createSession(data) { return this._create("sessions", data, ["workspace_id", "name", "description"]); }
  updateSession({ id, ...d }) { return this._update("sessions", id, d, ["name", "description"]); }
  async deleteSession({ id }) {
    const turns = await this._list("turns", { session_id: id });
    for (const t of turns) await this.deleteTurn({ id: t.id });
    return this._delete("sessions", id);
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

  // ---- messages（消息文本存于 contents，经 content_id 关联）----
  async addMessage({ step_id, seq, role, content, tool_call_id }) {
    const content_id = await this._nextId("contents");
    await this._insertRow("contents", ["id", "content"], [content_id, content]);
    const id = await this._nextId("messages");
    const cols = ["id", "step_id", "seq", "role", "content_id"]; const vals = [id, step_id, seq, role, content_id]; if (tool_call_id !== undefined && tool_call_id !== null) { cols.push("tool_call_id"); vals.push(String(tool_call_id)); } await this._insertRow("messages", cols, vals);
    return this.getMessage({ id });
  }
  async getMessage({ id }) {
    return this.db.prepare(
      "SELECT messages.id, messages.step_id, messages.seq, messages.role, messages.content_id, messages.tool_call_id, contents.content, messages.created_at, messages.updated_at FROM messages JOIN contents ON contents.id=messages.content_id WHERE messages.id=$1"
    ).get(id);
  }
  async listMessages({ step_id }) {
    return this.db.prepare(
      "SELECT messages.id, messages.step_id, messages.seq, messages.role, messages.content_id, messages.tool_call_id, contents.content, messages.created_at, messages.updated_at FROM messages JOIN contents ON contents.id=messages.content_id WHERE messages.step_id=$1 ORDER BY messages.seq"
    ).all(step_id);
  }
  async deleteMessage({ id }) {
    const msg = await this._get("messages", id);
    if (!msg) return;
    const callsToDel = await this.db.prepare("SELECT result_id FROM calls WHERE reply_id=$1").all(msg.content_id);
    for (const c of callsToDel) if (c.result_id != null) await this._delete("contents", c.result_id);
    await this.db.prepare("DELETE FROM calls WHERE reply_id=$1").run(msg.content_id);
    await this._delete("messages", id);
    return this._delete("contents", msg.content_id);
  }

  // ---- calls（工具调用，arguments 为 jsonb；result 存于 contents）----
  async addCall({ reply_id, seq, name, description, arguments: args, status, type, result, error, id }) {
    let result_id = null;
    if (result !== undefined && result !== null) {
      result_id = await this._nextId("contents");
      const rc = typeof result === "string" ? result : JSON.stringify(result);
      await this._insertRow("contents", ["id", "content"], [result_id, rc]);
    }
    const cid = id != null ? id : await this._nextId("calls");
    const argJson = args && typeof args === "object" ? JSON.stringify(args) : (args || "{}");
    const cols = ["id", "reply_id", "seq", "name"]; const vals = [cid, reply_id, seq, name];
    if (description !== undefined) { cols.push("description"); vals.push(description); }
    cols.push('"arguments"'); vals.push(argJson);
    if (status !== undefined) { cols.push("status"); vals.push(status); }
    if (result_id !== null) { cols.push("result_id"); vals.push(result_id); }
    if (error !== undefined) { cols.push("error"); vals.push(error); }
    cols.push("type"); vals.push(type);
    await this._insertRow("calls", cols, vals);
    return this.getCall({ id: cid });
  }
  _callRow(row) { if (row) row.arguments = _j(row.arguments); return row; }
  async getCall({ id }) {
    const row = await this.db.prepare(
      'SELECT id, reply_id, seq, name, description, "arguments", status, result_id, error, type, created_at, updated_at FROM calls WHERE id=$1'
    ).get(id);
    return this._callRow(row);
  }
  async listCallsByReply({ reply_id }) {
    const rows = await this.db.prepare(
      'SELECT id, reply_id, seq, name, description, "arguments", status, result_id, error, type, created_at, updated_at FROM calls WHERE reply_id=$1 ORDER BY seq'
    ).all(reply_id);
    return rows.map((r) => this._callRow(r));
  }
  async updateCall({ id, status, error, result }) {
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
  }
  async deleteCall({ id }) {
    const call = await this._get("calls", id);
    if (call && call.result_id != null) await this._delete("contents", call.result_id);
    return this._delete("calls", id);
  }

  // ================= 注册表：供应者 / 模型 / 工具 / 技能 / 配置 =================
  listProviders() { return this._list("providers"); }
  createProvider(data) { return this._create("providers", data, ["name", "description", "baseurl", "apikey"]); }
  updateProvider({ id, ...d }) { return this._update("providers", id, d, ["name", "description", "baseurl", "apikey"]); }
  async deleteProvider({ id }) {
    const models = await this._list("models", { provider_id: id });
    for (const m of models) await this.deleteModel({ id: m.id });
    return this._delete("providers", id);
  }

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
