"use strict";

// Agent Team shared task board (docs/runtime/team.md).
//
// One board per subagent-tree root. Membership is not duplicated here: the
// subagent runtime already owns the tree, names, and continuable descendants.
// Team only owns durable task snapshots: readiness, ownership, revision CAS,
// dependency DAG, and advisory write-scope overlap.
//
// Team mode is implicit in this deployment: the board is available to every
// member of a tree, and the first task creates the board. DSH's per-root mode
// switch and UI projection are deliberately not copied.

const MAX_TASKS = 256;
const MAX_SUBJECT = 200;
const MAX_DESCRIPTION = 16384;
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);

function requiredText(value, field, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(field + " must be non-empty");
  if (text.length > maxLength) throw new Error(field + " exceeds " + maxLength + " characters");
  return text;
}

function writeScope(value) {
  if (typeof value !== "string") throw new Error("invalid workspace-relative write scope " + JSON.stringify(value));
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:/iu.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("invalid workspace-relative write scope " + JSON.stringify(value));
  }
  return normalized;
}

function normalizeScopes(values) {
  if (!Array.isArray(values)) throw new Error("write_scopes must be an array");
  return [...new Set(values.map(writeScope))];
}

function normalizeBlockers(values) {
  if (!Array.isArray(values)) throw new Error("blocked_by must be an array");
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) throw new Error("blocked_by must contain non-empty task ids");
    const id = value.trim();
    if (seen.has(id)) throw new Error('duplicate blocker "' + id + '"');
    seen.add(id);
  }
  return [...seen];
}

function scopesOverlap(left, right) {
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

class TeamService {
  /**
   * @param {object} deps
   * @param {object} deps.store storage with team.task.* ops
   * @param {object|Function} deps.subagents SubagentRuntime or a getter
   * @param {number} [deps.maxTasks]
   * @param {object} [deps.logger]
   */
  constructor({ store, subagents, maxTasks = MAX_TASKS, logger = console } = {}) {
    if (!store) throw new Error("TeamService requires a store");
    if (!subagents) throw new Error("TeamService requires the subagent runtime");
    this.store = store;
    this.subagents = subagents;
    this.maxTasks = Number.isInteger(maxTasks) && maxTasks > 0 ? maxTasks : MAX_TASKS;
    this.logger = logger;
  }

  _runtime() {
    return typeof this.subagents === "function" ? this.subagents() : this.subagents;
  }

  async _rawTask(teamId, taskId) {
    return this.store.run("team.task.get", { team_id: teamId, task_id: taskId });
  }

  _taskFrom(tasks, taskId) {
    const task = tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error('team task "' + taskId + '" not found');
    return task;
  }

  // A task view is derived, never stored: readiness and overlap warnings are a
  // function of the current board, so a stale sibling cannot make them stale.
  _view(task, tasks) {
    let ready = false;
    if (task.status === "pending") {
      ready = task.blockedBy.every(
        (id) => (tasks.find((candidate) => candidate.taskId === id) || {}).status === "completed",
      );
    }
    const warnings = new Set();
    if (task.status === "pending" || task.status === "in_progress") {
      for (const other of tasks) {
        if (other.taskId === task.taskId || other.status !== "in_progress") continue;
        if (task.writeScopes.some((left) => other.writeScopes.some((right) => scopesOverlap(left, right)))) {
          warnings.add("write scopes overlap with " + other.taskId);
        }
      }
    }
    return {
      id: task.taskId,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      ...(task.ownerId == null ? {} : { owner: task.ownerName || String(task.ownerId) }),
      blockedBy: [...task.blockedBy],
      writeScopes: [...task.writeScopes],
      ready,
      writeScopeWarnings: [...warnings],
    };
  }

  _assertDependencies(tasks, values, selfId) {
    const ids = normalizeBlockers(values);
    for (const id of ids) {
      if (id === selfId) throw new Error("a team task cannot block itself");
      const task = tasks.find((candidate) => candidate.taskId === id);
      if (!task || task.status === "deleted") throw new Error('blocker task "' + id + '" not found');
    }
    return ids;
  }

  // Reject a cycle before persistence. The board is a DAG, and a stale graph
  // must fail loudly instead of becoming an unreadable dependency loop.
  _assertGraph(tasks, candidate) {
    const map = new Map(tasks.map((task) => [task.taskId, task]));
    map.set(candidate.taskId, candidate);
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error("team task dependency cycle at " + id);
      const task = map.get(id);
      if (!task) return;
      visiting.add(id);
      for (const blocker of task.blockedBy) visit(blocker);
      visiting.delete(id);
      visited.add(id);
    };
    visit(candidate.taskId);
  }

  async _caller(callerSessionId) {
    if (callerSessionId == null) throw new Error("team tools require a calling session");
    const runtime = this._runtime();
    const rootId = await runtime.rootOf(callerSessionId);
    const name = await runtime.pathOf(callerSessionId);
    return {
      id: Number(callerSessionId),
      rootId: Number(rootId),
      name,
      lead: String(rootId) === String(callerSessionId),
      runtime,
    };
  }

  async _board(caller) {
    return this.store.run("team.task.list", { team_id: caller.rootId });
  }

  async createTask(callerSessionId, request = {}) {
    const caller = await this._caller(callerSessionId);
    const subject = requiredText(request.subject, "subject", MAX_SUBJECT);
    const description = requiredText(request.description, "description", MAX_DESCRIPTION);
    const tasks = await this._board(caller);
    const active = tasks.filter((task) => task.status !== "deleted").length;
    if (active >= this.maxTasks) throw new Error("Team task limit " + this.maxTasks + " reached");

    const blockedBy = this._assertDependencies(tasks, request.blockedBy || [], null);
    const writeScopes = normalizeScopes(request.writeScopes || []);
    const candidate = {
      taskId: "",
      revision: 1,
      subject,
      description,
      status: "pending",
      ownerId: null,
      ownerName: null,
      blockedBy,
      writeScopes,
    };
    // The numeric suffix is assigned by the store; graph validation runs on the
    // dependency shape, so an empty local id is fine until the insert returns.
    this._assertGraph(tasks, candidate);
    const row = await this.store.run("team.task.create", {
      team_id: caller.rootId,
      subject,
      description,
      blocked_by: blockedBy,
      write_scopes: writeScopes,
    });
    const current = await this._board(caller);
    return this._view(row, current);
  }

  async getTask(callerSessionId, taskId) {
    const caller = await this._caller(callerSessionId);
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!id) throw new Error("task_id is required");
    const tasks = await this._board(caller);
    return this._view(this._taskFrom(tasks, id), tasks);
  }

  async listTasks(callerSessionId, options = {}) {
    const caller = await this._caller(callerSessionId);
    if (options.owner != null && options.unowned != null) {
      throw new Error("owner and unowned filters cannot be combined");
    }
    const cursor = options.cursor == null ? 0 : Number(options.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
    const limit = options.limit == null ? 50 : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer from 1 through 100");
    }
    let ownerId;
    if (options.owner != null) {
      ownerId = await caller.runtime.resolveAgent(callerSessionId, options.owner);
      if (!ownerId) throw new Error('agent "' + options.owner + '" not found');
    }
    if (options.status != null && !STATUSES.has(options.status)) {
      throw new Error("invalid status " + JSON.stringify(options.status));
    }

    const tasks = await this._board(caller);
    const filtered = tasks
      .filter((task) => task.status !== "deleted")
      .map((task) => this._view(task, tasks))
      .filter((task) => options.status == null || task.status === options.status)
      .filter((task) => ownerId == null || String((tasks.find((raw) => raw.taskId === task.id) || {}).ownerId) === String(ownerId))
      .filter((task) => options.unowned == null || (task.owner == null) === !!options.unowned)
      .filter((task) => options.ready == null || task.ready === !!options.ready);
    const page = filtered.slice(cursor, cursor + limit);
    return {
      tasks: page,
      ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
    };
  }

  async _resolveAssignee(caller, owner) {
    const targetId = await caller.runtime.resolveAgent(caller.id, owner);
    if (targetId == null) throw new Error('agent "' + owner + '" not found');
    const target = Number(targetId);
    const targetRoot = Number(await caller.runtime.rootOf(target));
    if (String(targetRoot) !== String(caller.rootId)) {
      throw new Error('agent "' + owner + '" is not in this team');
    }
    const session = await this.store.run("session.get", { id: target });
    if (!session || session.deleted_at) throw new Error('agent "' + owner + '" is not available');
    return { ownerId: target, ownerName: await caller.runtime.pathOf(target) };
  }

  async updateTask(callerSessionId, request = {}) {
    const caller = await this._caller(callerSessionId);
    const id = typeof request.taskId === "string" ? request.taskId.trim() : "";
    if (!id) throw new Error("task_id is required");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
      throw new Error("expected_revision must be a positive integer");
    }
    const tasks = await this._board(caller);
    const current = this._taskFrom(tasks, id);
    if (current.status === "deleted") throw new Error('team task "' + id + '" is deleted');
    if (current.revision !== request.expectedRevision) {
      throw new Error(
        'stale team task "' + id + '" revision ' + request.expectedRevision + "; current revision is " + current.revision,
      );
    }

    const action = request.action;
    const lead = caller.lead;
    const owned = current.ownerId != null && String(current.ownerId) === String(caller.id);
    const authorizeOwner = () => {
      if (!lead && !owned) throw new Error("task mutation requires its owner or Team Lead");
    };
    let patch;
    switch (action) {
      case "claim": {
        if (current.ownerId != null && String(current.ownerId) !== String(caller.id)) {
          throw new Error('team task "' + id + '" is owned by another member');
        }
        if (current.status !== "pending") {
          throw new Error('team task "' + id + '" is ' + current.status + "; claim requires pending");
        }
        if (!this._view(current, tasks).ready) {
          throw new Error('team task "' + id + '" has unfinished dependencies; complete them before claiming');
        }
        patch = { status: "in_progress", owner_id: caller.id, owner_name: caller.name };
        break;
      }
      case "release":
        authorizeOwner();
        if (current.status !== "in_progress") throw new Error("only an in-progress task can be released");
        patch = { status: "pending", owner_id: null, owner_name: null };
        break;
      case "edit": {
        authorizeOwner();
        if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
          throw new Error("task edit requires subject, description, or write_scopes");
        }
        patch = {};
        if (request.subject !== undefined) patch.subject = requiredText(request.subject, "subject", MAX_SUBJECT);
        if (request.description !== undefined) {
          patch.description = requiredText(request.description, "description", MAX_DESCRIPTION);
        }
        if (request.writeScopes !== undefined) patch.write_scopes = normalizeScopes(request.writeScopes);
        break;
      }
      case "set_dependencies": {
        authorizeOwner();
        if (request.blockedBy === undefined) throw new Error("set_dependencies requires blocked_by");
        patch = { blocked_by: this._assertDependencies(tasks, request.blockedBy, id) };
        break;
      }
      case "complete":
        authorizeOwner();
        if (current.status !== "in_progress") throw new Error("only an in-progress task can complete");
        patch = { status: "completed" };
        break;
      case "reopen":
        authorizeOwner();
        if (current.status !== "completed") throw new Error("only a completed task can reopen");
        patch = { status: "pending", owner_id: null, owner_name: null };
        break;
      case "reassign": {
        if (!lead) throw new Error("only the Team Lead can reassign tasks");
        if (current.status !== "pending" && current.status !== "in_progress") {
          throw new Error("only a pending or in-progress task can be reassigned");
        }
        if (request.owner === undefined || request.owner === null || request.owner === "") {
          patch = { status: "pending", owner_id: null, owner_name: null };
          break;
        }
        if (!this._view(current, tasks).ready) throw new Error('team task "' + id + '" is blocked');
        const assignee = await this._resolveAssignee(caller, request.owner);
        patch = { status: "in_progress", owner_id: assignee.ownerId, owner_name: assignee.ownerName };
        break;
      }
      case "delete": {
        authorizeOwner();
        const dependent = tasks.find(
          (task) => task.status !== "deleted" && task.taskId !== id && task.blockedBy.includes(id),
        );
        if (dependent) throw new Error('team task "' + id + '" still blocks "' + dependent.taskId + '"');
        patch = { status: "deleted" };
        break;
      }
      default:
        throw new Error("unsupported task action " + JSON.stringify(action));
    }

    const candidate = {
      ...current,
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.owner_id !== undefined ? { ownerId: patch.owner_id } : {}),
      ...(patch.owner_name !== undefined ? { ownerName: patch.owner_name } : {}),
      ...(patch.blocked_by !== undefined ? { blockedBy: patch.blocked_by } : {}),
      ...(patch.write_scopes !== undefined ? { writeScopes: patch.write_scopes } : {}),
    };
    this._assertGraph(tasks, candidate);
    const result = await this.store.run("team.task.cas", {
      team_id: caller.rootId,
      task_id: id,
      expected_revision: request.expectedRevision,
      patch,
    });
    if (!result.applied) {
      const actual = await this._rawTask(caller.rootId, id);
      const revision = actual ? actual.revision : "missing";
      throw new Error('stale team task "' + id + '"; current revision is ' + revision);
    }
    const next = await this._board(caller);
    return this._view(this._taskFrom(next, id), next);
  }
}

const __exports = { TeamService, MAX_TASKS, MAX_SUBJECT, MAX_DESCRIPTION };
export { TeamService, MAX_TASKS, MAX_SUBJECT, MAX_DESCRIPTION };
export default __exports;
