"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcRegistry } from "../../../core/rpc/registry.js";
import defineTerminalCommands from "../../../core/rpc/handlers/terminal.js";
import { TerminalService } from "../../../lib/terminals/index.js";

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

test("terminal.panel RPC opens, lists and closes user terminals", async () => {
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  const core = {
    terminals: service,
    store: {
      getSession: async () => null,
      getWorkspace: async () => null,
    },
  };
  const rpc = new RpcRegistry(core);
  defineTerminalCommands(rpc);
  try {
    const opened = await rpc.handle("terminal.panel.open", { session_id: "panel-rpc" });
    assert.equal(opened.createdBy, "user");
    assert.equal(opened.control, "user");

    const list = await rpc.handle("terminal.panel.list", { session_id: "panel-rpc" });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, opened.id);
    assert.equal(list[0].running, "no");

    const closed = await rpc.handle("terminal.panel.close", {
      session_id: "panel-rpc",
      id: opened.id,
    });
    assert.equal(closed.closed, true);
    assert.deepEqual(await rpc.handle("terminal.panel.list", { session_id: "panel-rpc" }), []);
  } finally {
    service.disposeAll();
  }
});
