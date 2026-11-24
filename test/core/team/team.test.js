"use strict";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createStore } from "../../../core/storage/store.js";
import { TeamService } from "../../../core/team/index.js";

const DB = "/tmp/team-service-" + process.pid + ".db";
let store;

function runtime() {
  const tree = new Map([
    [2, { parent: 1, name: "reviewer" }],
    [3, { parent: 2, name: "checker" }],
  ]);
  const rootOf = (id) => {
    let current = Number(id);
    for (let guard = 0; tree.has(current); guard += 1) {
      if (guard > 10) throw new Error("cycle");
      current = tree.get(current).parent;
    }
    return current;
  };
  const pathOf = (id) => {
    const parts = [];
    let current = Number(id);
    for (let guard = 0; tree.has(current); guard += 1) {
      if (guard > 10) throw new Error("cycle");
      parts.unshift(tree.get(current).name);
      current = tree.get(current).parent;
    }
    return parts.length ? parts.join("/") : "lead";
  };
  return {
    rootOf,
    pathOf,
    async resolveAgent(_caller, name) {
      if (name === "lead") return 1;
      if (name === "reviewer") return 2;
      if (name === "reviewer/checker") return 3;
      return name;
    },
  };
}

before(async () => {
  rmSync(DB, { force: true });
  store = await createStore({ path: DB });
  const ws = await store.run("workspace.create", { folder_path: "/tmp/team-test-ws", folder_name: "team" });
  await store.run("session.create", { workspace_id: ws.id, name: "lead", kind: "normal" });
  await store.run("session.create", { workspace_id: ws.id, name: "reviewer", kind: "subagent" });
  await store.run("session.create", { workspace_id: ws.id, name: "checker", kind: "subagent" });
});

after(async () => {
  if (store) await store.close();
  rmSync(DB, { force: true });
});

function service(maxTasks) {
  return new TeamService({ store, subagents: runtime(), maxTasks });
}

test("create, list, claim and complete one task", async () => {
  const team = service();
  const task = await team.createTask(1, {
    subject: "Review diff",
    description: "Check the implementation and tests.",
    writeScopes: ["core/team/"],
  });
  assert.equal(task.id, "task-1");
  assert.equal(task.revision, 1);
  assert.equal(task.status, "pending");
  assert.equal(task.ready, true);
  assert.deepEqual(task.writeScopes, ["core/team"]);

  const page = await team.listTasks(1, { ready: true });
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0].owner, undefined);

  const claimed = await team.updateTask(2, {
    taskId: task.id,
    expectedRevision: 1,
    action: "claim",
  });
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.owner, "reviewer");
  assert.equal(claimed.revision, 2);

  const completed = await team.updateTask(2, {
    taskId: task.id,
    expectedRevision: 2,
    action: "complete",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 3);
});

test("dependencies block claims until completed, then unlock", async () => {
  const team = service();
  const first = await team.createTask(1, { subject: "First", description: "Do the first part." });
  const second = await team.createTask(1, {
    subject: "Second",
    description: "Depends on the first.",
    blockedBy: [first.id],
  });
  assert.equal(second.ready, false);
  await assert.rejects(
    team.updateTask(2, { taskId: second.id, expectedRevision: 1, action: "claim" }),
    /unfinished dependencies/,
  );
  await team.updateTask(2, { taskId: first.id, expectedRevision: 1, action: "claim" });
  await team.updateTask(2, { taskId: first.id, expectedRevision: 2, action: "complete" });
  const unlocked = await team.getTask(1, second.id);
  assert.equal(unlocked.ready, true);
  await team.updateTask(2, { taskId: second.id, expectedRevision: 1, action: "claim" });
});

test("rejects stale revisions and unauthorized mutations", async () => {
  const team = service();
  const task = await team.createTask(1, { subject: "CAS", description: "Check compare-and-set." });
  const claimed = await team.updateTask(2, { taskId: task.id, expectedRevision: 1, action: "claim" });
  await assert.rejects(
    team.updateTask(1, { taskId: task.id, expectedRevision: 1, action: "complete" }),
    /stale team task/,
  );
  await assert.rejects(
    team.updateTask(3, { taskId: task.id, expectedRevision: claimed.revision, action: "complete" }),
    /owner or Team Lead/,
  );
  await team.updateTask(2, { taskId: task.id, expectedRevision: claimed.revision, action: "complete" });
});

test("only the Lead reassigns, and reassign resolves tree names", async () => {
  const team = service();
  const task = await team.createTask(1, { subject: "Assign", description: "Assign this task." });
  const assigned = await team.updateTask(1, {
    taskId: task.id,
    expectedRevision: 1,
    action: "reassign",
    owner: "reviewer/checker",
  });
  assert.equal(assigned.owner, "reviewer/checker");
  assert.equal(assigned.status, "in_progress");
  await assert.rejects(
    team.updateTask(2, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: "reassign",
      owner: "reviewer",
    }),
    /only the Team Lead/,
  );
  const unassigned = await team.updateTask(1, {
    taskId: task.id,
    expectedRevision: assigned.revision,
    action: "reassign",
  });
  assert.equal(unassigned.owner, undefined);
  assert.equal(unassigned.status, "pending");
});

test("write scopes warn on overlap and are normalized", async () => {
  const team = service();
  const first = await team.createTask(1, {
    subject: "One",
    description: "Owns core.",
    writeScopes: ["./core/"],
  });
  const second = await team.createTask(1, {
    subject: "Two",
    description: "Also touches core/team.",
    writeScopes: ["core/team"],
  });
  await team.updateTask(1, { taskId: first.id, expectedRevision: 1, action: "claim" });
  const view = await team.getTask(1, second.id);
  assert.deepEqual(view.writeScopes, ["core/team"]);
  assert.deepEqual(view.writeScopeWarnings, ["write scopes overlap with " + first.id]);
  await assert.rejects(
    team.createTask(1, { subject: "Bad", description: "Bad scope.", writeScopes: [123] }),
    /invalid workspace-relative write scope/,
  );
  await assert.rejects(
    team.createTask(1, { subject: "Bad", description: "Bad scope.", writeScopes: ["../outside"] }),
    /invalid workspace-relative write scope/,
  );
});

test("delete keeps a tombstone and refuses while dependents exist", async () => {
  const team = service();
  const parent = await team.createTask(1, { subject: "Parent", description: "Parent task." });
  const child = await team.createTask(1, {
    subject: "Child",
    description: "Child task.",
    blockedBy: [parent.id],
  });
  await assert.rejects(
    team.updateTask(1, { taskId: parent.id, expectedRevision: 1, action: "delete" }),
    /still blocks/,
  );
  const deleted = await team.updateTask(1, { taskId: child.id, expectedRevision: 1, action: "delete" });
  assert.equal(deleted.status, "deleted");
  const page = await team.listTasks(1, {});
  assert.equal(page.tasks.some((entry) => entry.id === child.id), false);
  assert.equal((await team.getTask(1, child.id)).status, "deleted");
  const removed = await team.updateTask(1, { taskId: parent.id, expectedRevision: 1, action: "delete" });
  assert.equal(removed.status, "deleted");
});

test("store CAS reports the loser even when the winning write lands revision+1", async () => {
  const team = service();
  const task = await team.createTask(1, { subject: "Race", description: "CAS race." });
  const first = await store.run("team.task.cas", {
    team_id: 1,
    task_id: task.id,
    expected_revision: 1,
    patch: { subject: "Winner" },
  });
  assert.equal(first.applied, true);
  assert.equal(first.task.revision, 2);
  const second = await store.run("team.task.cas", {
    team_id: 1,
    task_id: task.id,
    expected_revision: 1,
    patch: { subject: "Loser" },
  });
  assert.equal(second.applied, false);
  assert.equal(second.task.revision, 2);
  assert.equal(second.task.subject, "Winner");
});

test("enforces maxTasks and rejects cycles", async () => {
  const team = service(2);
  team.maxTasks = (await team.listTasks(1, {})).tasks.length + 2;
  await team.createTask(1, { subject: "A", description: "A" });
  await team.createTask(1, { subject: "B", description: "B" });
  await assert.rejects(
    team.createTask(1, { subject: "C", description: "C" }),
    /Team task limit/,
  );

  const other = service();
  const a = await other.createTask(1, { subject: "A", description: "A" });
  const b = await other.createTask(1, { subject: "B", description: "B", blockedBy: [a.id] });
  await assert.rejects(
    other.updateTask(1, {
      taskId: a.id,
      expectedRevision: 1,
      action: "set_dependencies",
      blockedBy: [b.id],
    }),
    /dependency cycle/,
  );
});
