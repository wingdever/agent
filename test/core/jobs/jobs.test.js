"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { JobService } from "../../../core/jobs/index.js";

function fakeStore() {
  const jobs = new Map();
  let id = 0;
  return {
    jobs,
    sessions: new Map([[1, { id: 1 }]]),
    async run(op, p = {}) {
      switch (op) {
        case "job.create": {
          id += 1;
          const row = {
            id,
            jobId: p.job_id,
            sessionId: p.session_id,
            kind: p.kind,
            label: p.label,
            status: p.status || "running",
            detail: null,
            result: null,
            output: p.output || null,
            ownerPid: p.owner_pid || null,
            boot: p.boot || null,
          };
          jobs.set(p.job_id, row);
          return row;
        }
        case "job.get":
          return jobs.get(p.job_id) || null;
        case "job.list":
          return [...jobs.values()].filter((j) => j.sessionId === p.session_id);
        case "job.complete": {
          const row = jobs.get(p.job_id);
          Object.assign(row, {
            status: p.status,
            detail: p.detail,
            result: p.result,
            output: p.output,
          });
          return row;
        }
        case "job.kill": {
          const row = jobs.get(p.job_id);
          if (row && row.status === "running") row.status = "killed";
          return row || null;
        }
        case "job.running":
          return [...jobs.values()].filter((j) => j.status === "running");
        case "job.fail": {
          const row = jobs.get(p.job_id);
          if (row && row.status === "running") {
            row.status = "failed";
            row.detail = p.detail || "interrupted by restart";
          }
          return row || null;
        }
        case "session.get":
          return this.sessions.get(p.id) || null;
        default:
          throw new Error("unexpected op " + op);
      }
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("start settles a job, persists it and delivers one completion notice", async () => {
  const store = fakeStore();
  const notices = [];
  const service = new JobService({
    store,
    resume: async (ctx) => { notices.push(ctx); },
    now: () => new Date(1000),
  });

  const { jobId } = await service.start({
    kind: "workflow",
    label: "audit",
    sessionId: 1,
    run: async (job) => {
      job.append("phase: scan");
      return {
        done: Promise.resolve({ status: "completed", detail: "2 agents", result: "ok" }),
      };
    },
  });

  assert.match(jobId, /^job_/);
  const out = await service.wait(jobId, 1000);
  assert.equal(out.status, "completed");
  assert.equal(out.result, "ok");
  assert.match(out.output, /phase: scan/);
  assert.equal(store.jobs.get(jobId).status, "completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].inputSource, "job-settle");
  assert.match(notices[0].messages[0].content, /completed/);
});

test("a throwing run becomes failed instead of escaping", async () => {
  const store = fakeStore();
  const notices = [];
  const service = new JobService({
    store,
    resume: async (ctx) => { notices.push(ctx); },
  });

  const { jobId } = await service.start({
    kind: "custom",
    sessionId: 1,
    run: async () => { throw new Error("boom"); },
  });
  const out = await service.wait(jobId, 1000);
  assert.equal(out.status, "failed");
  assert.match(out.detail, /boom/);
  assert.equal(notices.length, 1);
  assert.match(notices[0].messages[0].content, /failed: boom/);
});

test("kill cancels the live run and suppresses the completion notice", async () => {
  const store = fakeStore();
  const notices = [];
  const service = new JobService({
    store,
    resume: async (ctx) => { notices.push(ctx); },
  });
  const gate = deferred();
  let cancelled = false;

  const { jobId } = await service.start({
    kind: "workflow",
    label: "slow",
    sessionId: 1,
    run: async () => ({
      done: gate.promise,
      cancel: async () => {
        cancelled = true;
        gate.resolve({ status: "killed" });
      },
    }),
  });

  const killed = await service.kill(jobId);
  assert.equal(killed.status, "killed");
  assert.equal(cancelled, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(notices.length, 0);
  const stored = await store.run("job.get", { job_id: jobId });
  assert.equal(stored.status, "killed");
});

test("wait returns running when the timeout expires", async () => {
  const store = fakeStore();
  const service = new JobService({
    store,
    resume: async () => {},
  });
  const { jobId } = await service.start({
    kind: "custom",
    sessionId: 1,
    run: async (job) => {
      job.append("working");
      return { done: new Promise(() => {}) };
    },
  });
  const before = Date.now();
  const out = await service.wait(jobId, 1);
  assert.equal(out.status, "running");
  assert.match(out.output, /working/);
  assert.ok(Date.now() - before < 500);
});

test("init recovers interrupted running rows as failed", async () => {
  const store = fakeStore();
  const service = new JobService({
    store,
    resume: async () => {},
  });
  store.jobs.set("job_old_1", {
    jobId: "job_old_1",
    sessionId: 1,
    kind: "custom",
    status: "running",
    ownerPid: 999999,
    boot: "previous-boot",
  });
  const recovered = await service.init();
  assert.equal(recovered.length, 1);
  assert.equal(store.jobs.get("job_old_1").status, "failed");
  assert.match(store.jobs.get("job_old_1").detail, /restart/);
});

test("init leaves running rows owned by another live process alone", async () => {
  const store = fakeStore();
  const service = new JobService({
    store,
    resume: async () => {},
  });
  store.jobs.set("job_other_1", {
    jobId: "job_other_1",
    sessionId: 1,
    kind: "custom",
    status: "running",
    ownerPid: 1,
    boot: "other-boot",
  });
  const recovered = await service.init();
  assert.equal(recovered.length, 0);
  assert.equal(store.jobs.get("job_other_1").status, "running");
});

test("the output ring keeps only the newest lines", async () => {
  const store = fakeStore();
  const service = new JobService({
    store,
    resume: async () => {},
  });
  const { jobId } = await service.start({
    kind: "custom",
    sessionId: 1,
    run: async (job) => {
      for (let i = 0; i < 250; i += 1) job.append("line-" + i);
      return { done: Promise.resolve({ status: "completed" }) };
    },
  });
  const out = await service.wait(jobId, 1000);
  const lines = out.output.split("\n");
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "line-50");
  assert.equal(lines[199], "line-249");
});
