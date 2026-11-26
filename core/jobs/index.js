"use strict";

// Background jobs: a tool starts work, gets a job id immediately, and the run
// settles later. The run is in-process (no worker pool): the tool owns what
// "work" means, this service owns identity, status, the output ring, cancellation
// and the completion notice. Facts are persisted in `jobs`, not in tool-call rows.
//
// Completion delivery mirrors subagent settlement: one follow-up user message
// with source `job-settle` is queued into the owning session, so the model sees
// the result at the next turn boundary instead of blocking the tool call.

import crypto from "node:crypto";

const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_BYTES = 20000;

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

function tailBytes(text, maxBytes) {
  const value = String(text == null ? "" : text);
  if (byteLength(value) <= maxBytes) return value;
  const buf = Buffer.from(value, "utf8");
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

function oneLine(value, max = 120) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

class JobService {
  /**
   * @param {object} deps
   * @param {object} deps.store storage with job.* ops
   * @param {Function} [deps.getAgent] (sessionId) => agent instance or null
   * @param {Function} deps.resume (ctx) => Promise, usually core.agent.chat
   * @param {Function} [deps.now]
   * @param {object} [deps.logger]
   */
  constructor({ store, getAgent, resume, now = () => new Date(), logger = console } = {}) {
    if (!store) throw new Error("JobService requires a store");
    if (typeof resume !== "function") throw new Error("JobService requires a resume function");
    this.store = store;
    this.getAgent = getAgent || (() => null);
    this.resume = resume;
    this.now = now;
    this.logger = logger;
    this.active = new Map(); // jobId -> live record
    this._seq = 0;
    this.pid = process.pid;
    this.bootId = crypto.randomUUID();
  }

  // A running row from a previous boot has no live run to settle it. Rows
  // owned by another live process sharing this store are left alone: this
  // project runs the desktop app and the channel daemon against one data dir.
  async init() {
    let rows = [];
    try {
      rows = await this.store.run("job.running");
    } catch (e) {
      this.logger.warn("[jobs] running-job scan failed: " + ((e && e.message) || e));
      return [];
    }
    const recovered = [];
    let skipped = 0;
    for (const row of rows) {
      if (row.boot === this.bootId) continue;
      if (row.ownerPid && row.ownerPid !== this.pid && pidAlive(row.ownerPid)) {
        skipped += 1;
        continue;
      }
      try {
        recovered.push(await this.store.run("job.fail", {
          job_id: row.jobId,
          detail: "interrupted by restart",
        }));
      } catch (e) {
        this.logger.warn("[jobs] recover failed for " + row.jobId + ": " + ((e && e.message) || e));
      }
    }
    if (recovered.length) {
      this.logger.warn(`[jobs] recovered ${recovered.length} interrupted job(s) as failed`);
    }
    if (skipped) {
      this.logger.warn(`[jobs] left ${skipped} running job(s) owned by another live process`);
    }
    return recovered;
  }

  _newId() {
    this._seq = (this._seq || 0) + 1;
    return "job_" + this.now().getTime().toString(36) + "_" + this._seq.toString(36);
  }

  /**
   * Start one job. The record is persisted before the body runs, so a crash
   * leaves a recoverable `running` row instead of an invisible orphan.
   *
   * @param {object} spec { kind, label?, sessionId, chatCtx?, onEvent?, run }
   *        run(job): { done: Promise<{status, detail?, result?}>, cancel? }
   * @returns {Promise<{jobId: string}>}
   */
  async start(spec = {}) {
    const { kind, label, sessionId, chatCtx, onEvent, run } = spec;
    if (typeof kind !== "string" || !kind.trim()) throw new Error("job kind is required");
    if (typeof run !== "function") throw new Error("job run function is required");
    if (sessionId == null) throw new Error("job requires a sessionId");

    const jobId = this._newId();
    const live = {
      jobId,
      kind,
      label: label ? String(label) : "",
      sessionId,
      chatCtx: chatCtx || {},
      onEvent: typeof onEvent === "function" ? onEvent : null,
      status: "running",
      detail: null,
      result: null,
      lines: [],
      bytes: 0,
      cancel: null,
      notified: false,
      done: null,
    };
    this.active.set(jobId, live);

    await this.store.run("job.create", {
      job_id: jobId,
      session_id: sessionId,
      kind,
      label: live.label || null,
      owner_pid: this.pid,
      boot: this.bootId,
    }).catch((e) => {
      this.active.delete(jobId);
      throw e;
    });

    const emit = (type, payload) => {
      if (!live.onEvent) return;
      try { live.onEvent({ type, jobId, ...payload }); } catch (_) { /* advisory */ }
    };
    emit("job-start", { kind, label: live.label });

    const append = (line) => {
      const text = String(line == null ? "" : line).replace(/\r\n/g, "\n").trimEnd();
      if (!text) return;
      for (const part of text.split("\n")) {
        live.lines.push(part);
        live.bytes += byteLength(part) + 1;
        while (live.lines.length > MAX_OUTPUT_LINES || live.bytes > MAX_OUTPUT_BYTES) {
          const dropped = live.lines.shift();
          live.bytes -= byteLength(dropped) + 1;
        }
      }
      emit("job-output", { line: text });
    };

    const jobApi = { jobId, kind, label: live.label, append };

    const task = (async () => {
      let started;
      try {
        started = await run(jobApi);
      } catch (e) {
        return { status: "failed", detail: (e && e.message) || String(e) };
      }
      if (started && typeof started.cancel === "function") live.cancel = started.cancel;
      if (!started || !started.done || typeof started.done.then !== "function") {
        return { status: "failed", detail: "job run returned no done promise" };
      }
      try {
        return await started.done;
      } catch (e) {
        return { status: "failed", detail: (e && e.message) || String(e) };
      }
    })();

    live.done = task.then((outcome) => this._settle(live, outcome));
    // Nobody awaits live.done on the start path; keep a rejected settle from
    // becoming an unhandled rejection. _settle itself never throws.
    live.done.catch(() => {});
    return { jobId };
  }

  async _settle(live, outcome = {}) {
    const wasKilled = live.status === "killed";
    const status = wasKilled
      ? "killed"
      : (["completed", "failed"].includes(outcome.status) ? outcome.status : "failed");
    const detail = wasKilled ? (live.detail || "cancelled") : (outcome.detail != null ? String(outcome.detail) : null);
    const result = wasKilled ? null : (outcome.result != null ? String(outcome.result) : null);
    const output = live.lines.length ? live.lines.join("\n") : null;

    live.status = status;
    live.detail = detail;
    live.result = result;
    live.output = output;
    live.endedAt = this.now().toISOString();

    try {
      await this.store.run("job.complete", {
        job_id: live.jobId,
        status,
        detail,
        result,
        output,
      });
    } catch (e) {
      this.logger.warn("[jobs] persist failed for " + live.jobId + ": " + ((e && e.message) || e));
    }

    if (live.onEvent) {
      try {
        live.onEvent({
          type: "job-update",
          jobId: live.jobId,
          status,
          detail: detail || undefined,
          result: result || undefined,
        });
      } catch (_) { /* advisory */ }
    }

    if (status !== "killed" && !live.notified) {
      live.notified = true;
      // The notice is a follow-up turn, not part of settling: job_wait must
      // return as soon as the result is persisted, even if the session is busy.
      this._notify(live).catch((e) => {
        this.logger.warn("[jobs] completion notice failed for " + live.jobId + ": " + ((e && e.message) || e));
      });
    }
    this.active.delete(live.jobId);
    return { jobId: live.jobId, status, detail, result, output };
  }

  _noticeText(live) {
    const subject = "Background job " + live.jobId + (live.label ? ` (${live.label})` : "") ;
    if (live.status === "failed") {
      return subject + " failed: " + (live.detail || "unknown error") +
        (live.output ? "\n\nRecent output:\n" + tailBytes(live.output, 4000) : "");
    }
    const result = live.result == null ? "" : String(live.result);
    return subject + " completed" +
      (live.detail ? " (" + live.detail + ")" : "") +
      ".\n\nResult:\n" + (result || "(no result)");
  }

  async _notify(live) {
    if (live.sessionId == null) return;
    const session = await this._loadSession(live.sessionId);
    if (!session || session.deleted_at) {
      this.logger.warn("[jobs] completion notice for " + live.jobId + " dropped: session unavailable");
      return;
    }
    await this._waitIdle(live.sessionId);
    const ctx = {
      ...live.chatCtx,
      messages: [{ role: "user", content: this._noticeText(live) }],
      sessionId: live.sessionId,
      inputSource: "job-settle",
      references: [],
    };
    try {
      await this.resume(ctx);
    } catch (e) {
      // DSH notifySettlement: warn only, never retry, never throw into the run.
      this.logger.warn("[jobs] completion notice failed for " + live.jobId + ": " + ((e && e.message) || e));
    }
  }

  // The notice is a follow-up turn: it must not race the turn that started the
  // job. Wait for idle, but never longer than the caller's patience; a busy
  // session still accepts the queued input at the next boundary.
  async _waitIdle(sessionId, maxMs = 30000) {
    const started = Date.now();
    while (true) {
      const agent = this.getAgent(sessionId);
      if (!agent || !agent.inTurn()) return true;
      if (Date.now() - started > maxMs) return false;
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  async _loadSession(sessionId) {
    try {
      return await this.store.run("session.get", { id: sessionId });
    } catch (_) {
      return null;
    }
  }

  async get(jobId) {
    const row = await this.store.run("job.get", { job_id: jobId });
    if (!row) return null;
    const live = this.active.get(jobId);
    return live ? this._merge(live, row) : row;
  }

  async list(sessionId) {
    const rows = await this.store.run("job.list", { session_id: sessionId });
    return rows.map((row) => {
      const live = this.active.get(row.jobId);
      return live ? this._merge(live, row) : row;
    });
  }

  _merge(live, row) {
    return {
      ...row,
      status: live.status,
      detail: live.detail,
      result: live.result,
      output: live.lines.length ? live.lines.join("\n") : row.output,
    };
  }

  /** Tail of a job's observation stream, plus its status. */
  async output(jobId) {
    const job = await this.get(jobId);
    if (!job) return null;
    return {
      jobId: job.jobId,
      kind: job.kind,
      label: job.label,
      status: job.status,
      detail: job.detail,
      result: job.result,
      output: job.output || "",
    };
  }

  /** Wait for a job to settle, or report `running` after the timeout. */
  async wait(jobId, timeoutMs = 10000) {
    const live = this.active.get(jobId);
    if (!live) return this.output(jobId);
    const timeout = Math.max(0, Math.min(Number(timeoutMs) || 0, 30000));
    if (timeout === 0) return this.output(jobId);
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeout);
    });
    await Promise.race([live.done, timedOut]);
    clearTimeout(timer);
    return this.output(jobId);
  }

  /** Cancel a running job; terminal jobs report their current status. */
  async kill(jobId) {
    const live = this.active.get(jobId);
    if (!live) {
      const row = await this.store.run("job.get", { job_id: jobId });
      if (!row) return null;
      if (row.status === "running") await this.store.run("job.kill", { job_id: jobId });
      return this.store.run("job.get", { job_id: jobId });
    }
    if (live.status !== "running") return this.output(jobId);
    live.status = "killed";
    live.detail = "cancelled by user";
    try {
      if (typeof live.cancel === "function") await live.cancel("job cancelled");
    } catch (e) {
      this.logger.warn("[jobs] cancel failed for " + jobId + ": " + ((e && e.message) || e));
    }
    await this.store.run("job.kill", { job_id: jobId });
    if (live.onEvent) {
      try { live.onEvent({ type: "job-update", jobId, status: "killed", detail: "cancelled by user" }); } catch (_) {}
    }
    return this.output(jobId);
  }

  /** Cancel every active job and wait for their records to settle. */
  async disposeAll() {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.kill(id).catch(() => {})));
    await Promise.all(ids.map((id) => {
      const live = this.active.get(id);
      return live ? live.done.catch(() => {}) : Promise.resolve();
    }));
  }
}

function jobLabel(label, fallback = "job") {
  const text = oneLine(label, 60);
  return text || fallback;
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error && error.code === "EPERM";
  }
}

const __exports = { JobService, jobLabel, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES };
export { JobService, jobLabel, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES };
export default __exports;
