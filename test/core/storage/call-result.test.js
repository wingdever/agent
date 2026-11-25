"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../../core/storage/store.js";

test("call.list returns persisted result meta for history projections", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "call-result-test-"));
  const store = await createStore({ path: path.join(dir, "store.db") });
  try {
    await store._insertRow("workspaces", ["id", "folder_path", "folder_name"], [1, dir, "test"]);
    await store._insertRow("sessions", ["id", "workspace_id", "name"], [1, 1, "test"]);
    await store._insertRow("turns", ["id", "session_id", "seq"], [1, 1, 1]);
    await store._insertRow("steps", ["id", "turn_id", "seq"], [1, 1, 1]);
    await store._insertRow("messages", ["id", "step_id", "seq", "role"], [1, 1, 1, "assistant"]);
    await store._insertRow("calls", ["id", "reply_id", "seq", "name", "status", "category"], [1, 1, 1, "present", "running", "read"]);
    await store.updateCall({
      id: 1,
      status: "completed",
      result: { text: "Presented 1 file", meta: { files: [{ path: "/tmp/a.md", name: "a.md" }] } },
    });

    const calls = await store.listCallsByReply({ reply_id: 1 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].result.meta.files, [{ path: "/tmp/a.md", name: "a.md" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
