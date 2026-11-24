"use strict";

import {
  MAX_TIMER_DELAY_MS,
  describeTiming,
  isRecurring,
  latestOccurrence,
  nextOccurrence,
  normalizeTiming,
} from "./time.js";

function scheduleError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = /not_found|conflict|invalid|forbidden/.test(code) ? 400 : 500;
  return error;
}

function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function messageText(task, occurrenceAt) {
  return [
    "[SCHEDULE REMINDER]",
    "This is a scheduled message from the user",
    `schedule_id_json: ${JSON.stringify(task.scheduleId)}`,
    `occurrence_at: ${iso(occurrenceAt)}`,
    `reminder_prompt_json: ${JSON.stringify(task.prompt)}`,
  ].join("\n");
}

// Host-level scheduled delivery. A schedule is a persisted promise to create or
// wake a Session later, not an asynchronous execution handle: the actual turn is
// run by AgentRuntime.chat / the resume slot, exactly like a user follow-up.
// See docs/runtime/schedule.md for the boundary against JobService.
class ScheduleService {
  constructor({ store, resume, now = () => new Date(), logger, autoTimer = true } = {}) {
    if (!store) throw new Error("ScheduleService requires store");
    this.store = store;
    this.resume = resume;
    this.now = now;
    this.logger = logger;
    this.autoTimer = autoTimer;
    this._timer = null;
    this._stopping = false;
    this._driving = null;
    this._executing = new Set();
    // Deliveries that failed once are parked for this process; a restart or an
    // edit is the only way to retry, so a broken target cannot spin the timer.
    this._failed = new Set();
    this._armToken = 0;
  }

  async init() {
    await this.store.run("schedule.list");
    this._failed.clear();
    this._arm();
  }

  async dispose() {
    this._stopping = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _nowMs() {
    const value = this.now();
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(ms)) throw new Error("schedule clock returned an invalid time");
    return ms;
  }

  _log(level, event, fields = {}) {
    const fn = this.logger?.[level];
    if (typeof fn === "function") fn.call(this.logger, event, fields);
  }

  async _assertCallerAllowed(callerSessionId) {
    if (callerSessionId == null) throw scheduleError("invalid_caller", "schedule operations require a caller session");
    const session = await this.store.run("session.get", { id: callerSessionId });
    if (!session) throw scheduleError("invalid_caller", "caller session does not exist");
    if (session.deleted_at) throw scheduleError("invalid_caller", "caller session is deleted");
    const child = await this.store.run("subagent.get", { sub_sess_id: session.id });
    if (child) throw scheduleError("subagent_session", "A delegated subagent cannot use scheduled tasks.");
    return session;
  }

  async _assertTargetSession(sessionId) {
    const session = await this.store.run("session.get", { id: sessionId });
    if (!session) throw scheduleError("session_not_found", "target session does not exist");
    if (session.deleted_at) throw scheduleError("session_archived", "target session is archived or deleted");
    const child = await this.store.run("subagent.get", { sub_sess_id: session.id });
    if (child) throw scheduleError("subagent_session", "scheduled tasks cannot target a delegated subagent");
    return session;
  }

  _normalizeTarget(caller, target) {
    const value = target && typeof target === "object" ? target : { kind: target };
    const kind = value.kind;
    if (kind === "this_session") {
      return { kind: "session", sessionId: caller.id };
    }
    if (kind === "session") {
      if (!Number.isInteger(value.sessionId) && !Number.isInteger(value.session_id)) {
        throw scheduleError("invalid_target", "session target requires sessionId");
      }
      return { kind: "session", sessionId: Number(value.sessionId ?? value.session_id) };
    }
    if (kind === "new_once" || kind === "new") {
      return { kind, workspaceId: caller.workspace_id };
    }
    throw scheduleError("invalid_target", "target must be this_session, new_once, or new");
  }

  async _targetObject(caller, target) {
    const normalized = this._normalizeTarget(caller, target);
    if (normalized.kind === "session") await this._assertTargetSession(normalized.sessionId);
    return normalized;
  }

  async create(callerSessionId, { title, prompt, timing, target } = {}) {
    const caller = await this._assertCallerAllowed(callerSessionId);
    if (typeof title !== "string" || !title.trim()) throw scheduleError("invalid_title", "title must be non-empty");
    if (typeof prompt !== "string" || !prompt.trim()) throw scheduleError("invalid_prompt", "prompt must be non-empty");
    const targetObject = await this._targetObject(caller, target);
    const normalized = normalizeTiming(timing, this._nowMs());
    const task = await this.store.run("schedule.create", {
      title: title.trim(),
      prompt: prompt.trim(),
      timing: normalized.timing,
      target: targetObject,
      next_at: iso(normalized.nextAt),
    });
    this._log("info", "schedule.created", { scheduleId: task.scheduleId, nextAt: task.nextAt });
    this._arm();
    return task;
  }

  async list(callerSessionId, { active, limit = 50, offset = 0 } = {}) {
    await this._assertCallerAllowed(callerSessionId);
    let rows = await this.store.run("schedule.list");
    if (active === true) rows = rows.filter((task) => task.status === "active");
    else if (active === false) rows = rows.filter((task) => task.status !== "active");
    rows.sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (b.status === "active" && a.status !== "active") return 1;
      if (a.status === "active") return Date.parse(a.nextAt) - Date.parse(b.nextAt) || a.seq - b.seq;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.seq - b.seq;
    });
    const total = rows.length;
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const page = rows.slice(safeOffset, safeOffset + safeLimit);
    return { items: page.map((task) => this._view(task)), shown: page.length, total, limit: safeLimit, offset: safeOffset };
  }

  async view(callerSessionId, scheduleId) {
    await this._assertCallerAllowed(callerSessionId);
    const task = await this._get(scheduleId);
    return this._view(task);
  }

  async _get(scheduleId) {
    if (typeof scheduleId !== "string" || !scheduleId.trim()) throw scheduleError("invalid_schedule_id", "schedule_id must be a string");
    const task = await this.store.run("schedule.get", { schedule_id: scheduleId.trim() });
    if (!task) throw scheduleError("schedule_not_found", "schedule not found");
    return task;
  }

  _view(task) {
    return {
      id: task.scheduleId,
      revision: task.revision,
      title: task.title,
      prompt: task.prompt,
      timing: task.timing,
      target: { kind: task.target.kind, ...(task.target.sessionId ? { sessionId: task.target.sessionId } : {}) },
      status: task.status,
      scheduledAt: task.nextAt,
      nextAt: task.nextAt,
      lastDelivery: task.lastDelivery,
      executionActive: this._executing.has(task.scheduleId),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  async edit(callerSessionId, request = {}) {
    await this._assertCallerAllowed(callerSessionId);
    const id = request.id ?? request.schedule_id;
    if (typeof id !== "string" || !id.trim()) throw scheduleError("invalid_schedule_id", "id must be a non-empty schedule id");
    const task = await this._get(id.trim());
    const expected = request.expectedRevision ?? request.expected_revision ?? task.revision;
    if (!Number.isInteger(expected) || expected < 1) throw scheduleError("invalid_expected_revision", "expected_revision must be a positive integer");
    if (task.revision !== expected) {
      return failure("schedule_conflict", "The schedule changed since it was read. Refresh and try again.", { currentRevision: task.revision, task: this._view(task) });
    }
    const action = request.action || "update";
    if (action === "delete" || request.delete === true) {
      await this.store.run("schedule.delete", { schedule_id: task.scheduleId });
      this._failed.delete(task.scheduleId);
      this._log("info", "schedule.deleted", { scheduleId: task.scheduleId });
      this._arm();
      return { ok: true, id: task.scheduleId, revision: task.revision, deleted: true };
    }
    if (action !== "update") throw scheduleError("invalid_action", "action must be update or delete");
    if (!isRecord(request)) throw scheduleError("invalid_update", "edit needs at least one field");
    const patch = {};
    if (request.title !== undefined) {
      if (typeof request.title !== "string" || !request.title.trim()) throw scheduleError("invalid_title", "title must be non-empty");
      patch.title = request.title.trim();
    }
    if (request.prompt !== undefined) {
      if (typeof request.prompt !== "string" || !request.prompt.trim()) throw scheduleError("invalid_prompt", "prompt must be non-empty");
      patch.prompt = request.prompt.trim();
    }
    if (request.target !== undefined) {
      const caller = await this._assertCallerAllowed(callerSessionId);
      patch.target = await this._targetObject(caller, request.target);
    }
    let timing = task.timing;
    let nextAt = Date.parse(task.nextAt);
    if (request.timing !== undefined) {
      const normalized = normalizeTiming(request.timing, this._nowMs());
      timing = normalized.timing;
      nextAt = normalized.nextAt;
      patch.timing = timing;
    }
    const requestedActive = request.active;
    if (requestedActive !== undefined && typeof requestedActive !== "boolean") {
      throw scheduleError("invalid_active", "active must be a boolean");
    }
    if (requestedActive === false) {
      patch.status = "paused";
    } else if (requestedActive === true) {
      if (task.status === "ended" && request.timing === undefined) {
        throw scheduleError("schedule_ended", "the schedule has ended; provide a new timing to reactivate it");
      }
      if (nextAt <= this._nowMs()) {
        const next = nextOccurrence(timing, this._nowMs(), true);
        if (next == null) throw scheduleError("schedule_ended", "the schedule has no future occurrence");
        nextAt = next;
        patch.next_at = iso(nextAt);
      }
      patch.status = "active";
    } else if (request.timing !== undefined) {
      patch.next_at = iso(nextAt);
      if (task.status === "ended") patch.status = "active";
    } else if (task.status === "ended") {
      throw scheduleError("schedule_ended", "the schedule has ended; provide a new timing to reactivate it");
    }
    if (patch.status === "active" && request.timing !== undefined && nextAt <= this._nowMs()) {
      throw scheduleError("not_future", "the scheduled time must be strictly in the future");
    }
    if (Object.keys(patch).length === 0) throw scheduleError("empty_update", "edit needs at least one field to change");
    const result = await this.store.run("schedule.cas", { schedule_id: task.scheduleId, expected_revision: expected, patch });
    if (!result.applied) {
      return failure("schedule_conflict", "The schedule changed while it was being edited. Refresh and try again.", {
        currentRevision: result.task?.revision,
        task: result.task ? this._view(result.task) : null,
      });
    }
    this._failed.delete(task.scheduleId);
    this._log("info", "schedule.updated", { scheduleId: result.task.scheduleId, revision: result.task.revision });
    this._arm();
    return { ok: true, task: this._view(result.task) };
  }

  _arm(skip = new Set()) {
    if (!this.autoTimer || this._stopping) return;
    const token = ++this._armToken;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.store.run("schedule.list").then((tasks) => {
      if (this._stopping || token !== this._armToken) return;
      const now = this._nowMs();
      let min = null;
      for (const task of tasks) {
        if (task.status !== "active") continue;
        if (skip.has(task.scheduleId) || this._failed.has(task.scheduleId)) continue;
        const at = Date.parse(task.nextAt);
        if (!Number.isFinite(at)) continue;
        if (min == null || at < min) min = at;
      }
      if (min == null) return;
      const delay = Math.max(0, Math.min(min - now, MAX_TIMER_DELAY_MS));
      this._timer = setTimeout(() => {
        this._timer = null;
        this._drive().catch((error) => this._log("error", "schedule.timer.failed", { error: String(error?.stack || error) }));
      }, delay);
      if (typeof this._timer.unref === "function") this._timer.unref();
    }).catch((error) => this._log("error", "schedule.arm.failed", { error: String(error?.stack || error) }));
  }

  async _drive() {
    if (this._driving) return this._driving;
    this._driving = (async () => {
      const failed = new Set();
      const now = this._nowMs();
      let tasks = await this.store.run("schedule.list");
      tasks = tasks.filter((task) => task.status === "active"
        && !this._executing.has(task.scheduleId)
        && !this._failed.has(task.scheduleId));
      tasks.sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt) || a.seq - b.seq);
      for (const task of tasks) {
        if (Date.parse(task.nextAt) > now) break;
        if (this._stopping) break;
        try {
          await this._deliver(task);
        } catch (error) {
          failed.add(task.scheduleId);
          this._failed.add(task.scheduleId);
          this._log("warn", "schedule.delivery.failed", {
            scheduleId: task.scheduleId,
            occurrenceAt: task.nextAt,
            error: error?.message || String(error),
          });
        }
      }
      this._arm(failed);
    })().finally(() => { this._driving = null; });
    return this._driving;
  }

  async _deliver(task) {
    const now = this._nowMs();
    let working = task;
    let occurrenceAt;
    if (isRecurring(task.timing)) {
      const latest = latestOccurrence(task.timing, now);
      if (latest == null) {
        // A recurring rule with no earlier occurrence is not due; treating it as
        // a delivery would let a corrupt row spin the timer at zero delay.
        throw scheduleError("schedule_no_occurrence", "recurring schedule has no occurrence at or before now");
      }
      occurrenceAt = latest;
    } else {
      occurrenceAt = Date.parse(task.nextAt);
      if (!Number.isFinite(occurrenceAt) || occurrenceAt > now) return;
    }

    const existingTarget = task.target?.kind === "session" ? task.target.sessionId : null;
    if (existingTarget) this._executing.add(task.scheduleId);
    try {
      let sessionId;
      if (task.target.kind === "session") {
        sessionId = task.target.sessionId;
        await this._assertTargetSession(sessionId);
      } else if (task.target.kind === "new_once") {
        if (task.target.sessionId) {
          sessionId = task.target.sessionId;
          await this._assertTargetSession(sessionId);
        } else {
          sessionId = await this._createTargetSession(task);
          if (!sessionId) throw scheduleError("target_unavailable", "could not create the target session");
          const updated = await this.store.run("schedule.cas", {
            schedule_id: task.scheduleId,
            expected_revision: task.revision,
            patch: { target: { kind: "session", sessionId } },
          });
          if (!updated.applied) {
            throw scheduleError("schedule_conflict", "schedule changed before the new_once target could be recorded");
          }
          working = updated.task;
        }
      } else if (task.target.kind === "new") {
        sessionId = await this._createTargetSession(task);
        if (!sessionId) throw scheduleError("target_unavailable", "could not create the target session");
      } else {
        throw scheduleError("invalid_target", "schedule target is invalid");
      }

      if (typeof sessionId !== "number") throw scheduleError("target_unavailable", "a scheduled delivery has no target session");
      await this._resumeDelivery(sessionId, messageText(task, occurrenceAt));
      const deliveredAt = this._nowMs();
      await this._advance(working, occurrenceAt, deliveredAt, sessionId);
      this._log("info", "schedule.delivered", {
        scheduleId: task.scheduleId,
        occurrenceAt: iso(occurrenceAt),
        targetSessionId: sessionId,
      });
    } finally {
      this._executing.delete(task.scheduleId);
    }
  }

  async _createTargetSession(task) {
    const workspaceId = task.target?.workspaceId;
    if (!Number.isInteger(workspaceId)) throw scheduleError("target_unavailable", "scheduled new sessions require a workspace");
    const workspace = await this.store.run("workspace.get", { id: workspaceId });
    if (!workspace) throw scheduleError("target_unavailable", "target workspace does not exist");
    const session = await this.store.run("session.create", {
      workspace_id: workspaceId,
      kind: "normal",
      name: task.title.slice(0, 120),
      description: "Scheduled task: " + task.title,
      activity: "research",
    });
    return session.id;
  }

  async _resumeDelivery(sessionId, text) {
    if (typeof this.resume !== "function") throw scheduleError("delivery_unavailable", "schedule delivery is not wired");
    // agent.chat persists the follow-up and, when the target is busy, projects
    // it into the session's next-turn queue instead of starting a second loop.
    // The promise resolves when the message is accepted, not when the model has
    // answered, which is exactly the acknowledgement a schedule occurrence needs.
    await this.resume({
      sessionId,
      messages: [{ role: "user", content: text }],
      inputSource: "schedule",
      references: [],
    });
  }

  async _advance(task, occurrenceAt, deliveredAt, targetSessionId) {
    const lastDelivery = {
      occurrenceAt: iso(occurrenceAt),
      deliveredAt: iso(deliveredAt),
      targetSessionId,
    };
    let status = "ended";
    let nextAt = Date.parse(task.nextAt);
    if (isRecurring(task.timing)) {
      const next = nextOccurrence(task.timing, deliveredAt, true);
      if (next != null) {
        nextAt = next;
        status = "active";
      }
    }
    const result = await this.store.run("schedule.cas", {
      schedule_id: task.scheduleId,
      expected_revision: task.revision,
      patch: {
        status,
        next_at: iso(nextAt),
        last_delivery: lastDelivery,
      },
    });
    if (!result.applied) {
      this._log("warn", "schedule.commit.conflict", { scheduleId: task.scheduleId, expectedRevision: task.revision });
    }
  }

  // Manual run is deliberately not exposed yet: it would need the same
  // acknowledgement path without advancing the occurrence clock, and the current
  // UI has no schedule page. Add it together with the UI, not before.

  async tick() {
    return this._drive();
  }
}

export { ScheduleService, describeTiming };
export default ScheduleService;
