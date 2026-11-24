"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createSessionBinder } from "../../../channels/inbound/sessions.js";

function fakeStore() {
  const sessions = new Map();
  let nextId = 100;
  return {
    sessions,
    run(name, params) {
      if (name === "workspace.list") return Promise.resolve([{ id: 1, folder_path: "/work" }]);
      if (name === "session.create") {
        const id = nextId++;
        const row = { id, ...params };
        sessions.set(id, row);
        return Promise.resolve(row);
      }
      if (name === "session.get") {
        return Promise.resolve(sessions.get(Number(params.id)) || null);
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    },
  };
}

test("a new conversation creates one session and reuses it afterwards", async () => {
  const store = fakeStore();
  const binder = createSessionBinder({ store });

  const first = await binder.resolve({ sessionId: "ch:feishu:bot:oc_1", type: "feishu", instanceId: "bot" });
  const second = await binder.resolve({ sessionId: "ch:feishu:bot:oc_1", type: "feishu", instanceId: "bot" });

  assert.equal(first, 100);
  assert.equal(second, 100, "the same chat must not open a second session");
  assert.equal(store.sessions.size, 1);
  assert.equal(store.sessions.get(first).workspace_id, 1, "new sessions join an existing workspace");
  assert.match(store.sessions.get(first).name, /oc_1/);
});

test("two chats get two sessions", async () => {
  const store = fakeStore();
  const binder = createSessionBinder({ store });

  const a = await binder.resolve({ sessionId: "ch:feishu:bot:oc_a" });
  const b = await binder.resolve({ sessionId: "ch:feishu:bot:oc_b" });

  assert.notEqual(a, b);
  assert.equal(store.sessions.size, 2);
});

test("a session deleted behind the channel's back is recreated, not reused", async () => {
  const store = fakeStore();
  const binder = createSessionBinder({ store });
  const first = await binder.resolve({ sessionId: "ch:feishu:bot:oc_1" });
  store.sessions.delete(first);

  const again = await binder.resolve({ sessionId: "ch:feishu:bot:oc_1" });
  assert.equal(again, 101);
  assert.equal(store.sessions.size, 1, "the stale binding must not leak a session");
});

test("the binding survives a restart through the map file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "binder-"));
  const file = path.join(dir, "sessions.json");
  const store = fakeStore();

  const first = createSessionBinder({ store, file });
  const id = await first.resolve({ sessionId: "ch:feishu:bot:oc_1" });

  const afterRestart = createSessionBinder({ store, file });
  const reused = await afterRestart.resolve({ sessionId: "ch:feishu:bot:oc_1" });
  assert.equal(reused, id);
  assert.equal(store.sessions.size, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});
