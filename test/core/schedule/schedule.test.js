"use strict";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createStore } from "../../../core/storage/store.js";
import { loadTools } from "../../../core/tools/registry.js";
import { validateToolArgs } from "../../../core/tools/executor.js";
import { ScheduleService } from "../../../core/schedule/index.js";
import { normalizeTiming, nextOccurrence, latestOccurrence } from "../../../core/schedule/time.js";

const DB = "/tmp/schedule-service-" + process.pid + ".db";
let store;
let ws;

before(async () => {
  rmSync(DB, { force: true });
  store = await createStore({ path: DB });
  ws = await store.run("workspace.create", { folder_path: "/tmp/schedule-test-ws", folder_name: "schedule" });
  await store.run("session.create", { workspace_id: ws.id, name: "root", kind: "normal" });
  await store.run("session.create", { workspace_id: ws.id, name: "child", kind: "subagent" });
  await store.run("subagent.add", { sub_sess_id: 2, par_sess_id: 1, agent_name: "child", delivery: "parent" });
});

after(async () => {
  if (store) await store.close();
  rmSync(DB, { force: true });
});

function service(nowRef, deliveries = []) {
  return new ScheduleService({
    store,
    autoTimer: false,
    now: () => new Date(nowRef.ms),
    resume: async (ctx) => { deliveries.push(ctx); },
  });
}

test("one-shot delivery persists once, ends, and uses the reminder framing", async () => {
  const clock = { ms: Date.parse("2026-11-23T10:00:00Z") };
  const sent = [];
  const svc = service(clock, sent);
  const task = await svc.create(1, {
    title: "Check the build",
    prompt: "Run the build check and report.",
    timing: { kind: "after", after_seconds: 60 },
    target: "this_session",
  });
  assert.match(task.scheduleId, /^schedule-/u);
  assert.equal(task.status, "active");
  assert.equal(task.revision, 1);

  await svc.tick();
  assert.equal(sent.length, 0, "not due yet");

  clock.ms += 60_000;
  await svc.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 1);
  assert.equal(sent[0].inputSource, "schedule");
  assert.match(sent[0].messages[0].content, /^\[SCHEDULE REMINDER\]/u);
  assert.match(sent[0].messages[0].content, /This is a scheduled message from the user/u);
  assert.match(sent[0].messages[0].content, /Run the build check and report\./u);

  const after = await svc.view(1, task.scheduleId);
  assert.equal(after.status, "ended");
  assert.equal(after.lastDelivery.targetSessionId, 1);
  assert.equal(after.revision, 2);

  await svc.tick();
  assert.equal(sent.length, 1, "ended task must not deliver again");
});

test("every interval advances one occurrence and coalesces a late wake-up", async () => {
  const clock = { ms: Date.parse("2026-11-23T10:00:00Z") };
  const sent = [];
  const svc = service(clock, sent);
  const task = await svc.create(1, {
    title: "Heartbeat",
    prompt: "Say tick.",
    timing: { kind: "every", every_seconds: 60 },
    target: "new_once",
  });
  clock.ms += 60_000;
  await svc.tick();
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].sessionId, 1, "new_once must create its own session");
  const firstTarget = sent[0].sessionId;
  const after = await svc.view(1, task.scheduleId);
  assert.equal(after.status, "active");
  assert.equal(Date.parse(after.nextAt), clock.ms + 60_000);
  assert.equal(after.target.kind, "session");
  assert.equal(after.target.sessionId, firstTarget);

  clock.ms += 60_000;
  await svc.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sessionId, firstTarget, "new_once reuses its created session");

  clock.ms += 3_600_000;
  await svc.tick();
  assert.equal(sent.length, 3, "one wake-up delivers one latest occurrence, not a replay");
  const recovered = await svc.view(1, task.scheduleId);
  assert.equal(Date.parse(recovered.nextAt), clock.ms + 60_000);
});

test("edit is CAS protected, pauses, resumes and deletes", async () => {
  const clock = { ms: Date.parse("2026-11-23T10:00:00Z") };
  const svc = service(clock);
  const task = await svc.create(1, {
    title: "Report",
    prompt: "Write the report.",
    timing: { kind: "daily", time: "09:00", time_zone: "Asia/Shanghai" },
    target: "this_session",
  });

  const stale = await svc.edit(1, {
    id: task.scheduleId,
    expectedRevision: 99,
    title: "Nope",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "schedule_conflict");

  const paused = await svc.edit(1, {
    id: task.scheduleId,
    expectedRevision: task.revision,
    active: false,
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.task.status, "paused");

  const resumed = await svc.edit(1, {
    id: task.scheduleId,
    expectedRevision: paused.task.revision,
    active: true,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.task.status, "active");
  assert.ok(Date.parse(resumed.task.nextAt) > clock.ms);

  const removed = await svc.edit(1, {
    id: task.scheduleId,
    expectedRevision: resumed.task.revision,
    action: "delete",
  });
  assert.equal(removed.deleted, true);
  await assert.rejects(() => svc.view(1, task.scheduleId), /not found/u);
});

test("delegated subagents cannot create schedules or be targeted", async () => {
  const clock = { ms: Date.parse("2026-11-23T10:00:00Z") };
  const svc = service(clock);
  await assert.rejects(() => svc.create(2, {
    title: "Nope",
    prompt: "Nope.",
    timing: { kind: "after", after_seconds: 60 },
    target: "this_session",
  }), (error) => error.code === "subagent_session");

  await assert.rejects(() => svc.create(1, {
    title: "Nope",
    prompt: "Nope.",
    timing: { kind: "after", after_seconds: 60 },
    target: { kind: "session", sessionId: 2 },
  }), (error) => error.code === "subagent_session");
});

test("restart only catches the latest missed occurrence", async () => {
  const clock = { ms: Date.parse("2026-11-23T10:00:00Z") };
  const sent = [];
  const svc = service(clock, sent);
  const task = await svc.create(1, {
    title: "Catch up",
    prompt: "Catch up once.",
    timing: { kind: "every", every_seconds: 60 },
    target: "this_session",
  });
  clock.ms += 3_600_000;
  await svc.tick();
  assert.equal(sent.length, 1);
  const after = await svc.view(1, task.scheduleId);
  assert.equal(Date.parse(after.nextAt), clock.ms + 60_000);
});

test("the four tools load with a usable schema", async () => {
  const tools = await loadTools();
  for (const name of ["schedule_create", "schedule_list", "schedule_view", "schedule_edit"]) {
    assert.ok(tools.has(name), name + " should load");
    assert.equal(tools.get(name).promptSection, "schedule");
  }
  const violations = validateToolArgs(tools.get("schedule_create"), {
    title: "t",
    prompt: "p",
    target: "this_session",
    timing: { kind: "after", after_seconds: 60 },
  });
  assert.deepEqual(violations, []);
  assert.ok(validateToolArgs(tools.get("schedule_create"), {
    title: "t",
    prompt: "p",
    timing: { kind: "after", after_seconds: 60 },
  }).length > 0);
});

test("timing arithmetic is bounded and rejects impossible rules", () => {
  assert.throws(() => {
    normalizeTiming({ kind: "every", every_seconds: 30 }, Date.now());
  }, /at least 60/u);

  const daily = {
    kind: "daily",
    time: "09:00:00.000",
    timeZone: "Asia/Shanghai",
  };
  const next = nextOccurrence(daily, Date.parse("2026-11-23T10:00:00Z"), true);
  assert.equal(new Date(next).toISOString(), "2026-11-24T01:00:00.000Z");
  const latest = latestOccurrence(daily, Date.parse("2026-11-23T10:00:00Z"));
  assert.equal(new Date(latest).toISOString(), "2026-11-23T01:00:00.000Z");

  const cron = normalizeTiming({
    kind: "cron",
    expression: "0 9 * * 1-5",
    time_zone: "Asia/Shanghai",
  }, Date.parse("2026-11-23T10:00:00Z"));
  assert.equal(new Date(cron.nextAt).toISOString(), "2026-11-24T01:00:00.000Z");

  const rrule = normalizeTiming({
    kind: "rrule",
    rrule: "DTSTART;TZID=Asia/Shanghai:20261124T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
  }, Date.parse("2026-11-23T10:00:00Z"));
  assert.equal(new Date(rrule.nextAt).toISOString(), "2026-11-25T01:00:00.000Z");
});
