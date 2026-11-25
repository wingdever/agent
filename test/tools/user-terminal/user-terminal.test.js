"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalService } from "../../../lib/terminals/index.js";
import { loadTools } from "../../../core/tools/registry.js";
import { SECTION_ORDERS } from "../../../core/system-prompt.js";
import terminalOpen from "../../../tools/terminal_open/run.js";
import terminalSend from "../../../tools/terminal_send/run.js";
import terminalSignal from "../../../tools/terminal_signal/run.js";
import terminalClose from "../../../tools/terminal_close/run.js";
import terminalList from "../../../tools/terminal_list/run.js";
import terminalRead from "../../../tools/terminal_read/run.js";
import userTerminalList from "../../../tools/user_terminal_list/run.js";
import userTerminalRead from "../../../tools/user_terminal_read/run.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "user-terminal-test-"));
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

function execFor(service, sessionId, cwd) {
  return { sessionId, cwd, terminals: service };
}

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError) throw lastError;
  throw new Error("condition was not met");
}

test("user terminal tools share the pty-panel section and register read-only schemas", async () => {
  const tools = await loadTools();
  for (const name of ["user_terminal_list", "user_terminal_read"]) {
    const tool = tools.get(name);
    assert.ok(tool, name + " is registered");
    assert.equal(tool.mode, "read");
    assert.equal(tool.group, "terminal");
    assert.equal(tool.promptSection, "pty-panel");
    assert.equal(tool.defaultVisible, true);
    assert.match(tool.prompt, /once the user types into one, you can only read it/);
  }
  assert.deepEqual(Object.keys(tools.get("user_terminal_list").parameters.properties), []);
  assert.deepEqual(
    Object.keys(tools.get("user_terminal_read").parameters.properties).sort(),
    ["id", "lines"],
  );
  assert.equal(tools.get("user_terminal_read").parameters.required[0], "id");
  assert.equal(SECTION_ORDERS.TOOL_PTY_PANEL, 1710);
});

test("a user-created panel terminal is not visible to agent tools", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await service.openPanel("panel-owner", { cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const agentList = await terminalList.run({}, execFor(service, "panel-owner", dir));
    assert.equal(agentList.meta.count, 0);

    const userList = await userTerminalList.run({}, execFor(service, "panel-owner", dir));
    assert.equal(userList.meta.count, 1);
    assert.match(userList.text, new RegExp(opened.id));
    assert.match(userList.text, /running=no/);

    service.input("panel-owner", opened.id, "sleep 3\r");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const busy = await userTerminalList.run({}, execFor(service, "panel-owner", dir));
    assert.match(busy.text, /running=yes/);

    const agentRead = await terminalRead.run({ sessionId: opened.id }, execFor(service, "panel-owner", dir));
    assert.equal(agentRead.isError, true);
    assert.match(agentRead.text, /created by the user/);

    const read = await userTerminalRead.run({ id: opened.id, lines: 20 }, execFor(service, "panel-owner", dir));
    assert.equal(read.isError, undefined);
    assert.match(read.meta.sessionId, /term_/);
  } finally {
    service.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("typing takes over an agent terminal; send/signal refuse and close only detaches", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell", name: "build" }, execFor(service, "takeover", dir));
    const id = opened.meta.sessionId;
    await new Promise((resolve) => setTimeout(resolve, 250));

    const beforeTakeover = await userTerminalRead.run({ id, lines: 20 }, execFor(service, "takeover", dir));
    assert.equal(beforeTakeover.isError, true);
    assert.match(beforeTakeover.text, /not controlled by the user/);

    service.input("takeover", id, "printf 'TAKEN_OVER\\n'\r");
    const read = await waitFor(async () => {
      const result = await userTerminalRead.run({ id, lines: 20 }, execFor(service, "takeover", dir));
      return result.text.includes("TAKEN_OVER") ? result : null;
    });
    // The rendered screen must not leak the private prompt sentinel.
    assert.doesNotMatch(read.text, /:P/);
    assert.match(read.text, /TAKEN_OVER/);

    const send = await terminalSend.run({ sessionId: id, text: "echo nope" }, execFor(service, "takeover", dir));
    assert.equal(send.isError, true);
    assert.match(send.text, /controlled by the user/);

    const signal = await terminalSignal.run({ sessionId: id, signal: "SIGTERM" }, execFor(service, "takeover", dir));
    assert.equal(signal.isError, true);
    assert.match(signal.text, /controlled by the user/);

    const closed = await terminalClose.run({ sessionId: id }, execFor(service, "takeover", dir));
    assert.equal(closed.isError, undefined);
    assert.equal(closed.meta.detached, true);

    const agentList = await terminalList.run({}, execFor(service, "takeover", dir));
    assert.equal(agentList.meta.count, 0);
    const userList = await userTerminalList.run({}, execFor(service, "takeover", dir));
    assert.equal(userList.meta.count, 1);
    assert.match(userList.text, /build/);

    const stillReadable = await userTerminalRead.run({ id, lines: 20 }, execFor(service, "takeover", dir));
    assert.equal(stillReadable.isError, undefined);
    assert.equal(service.getInteractive("takeover", id).alive, true);
  } finally {
    service.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("user_terminal_read reads the rendered screen, not ANSI source", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await service.openPanel("screen-owner", { cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 200));
    service.input("screen-owner", opened.id, "printf '\\033[31mred\\033[0m plain\\n'\r");
    const read = await waitFor(async () => {
      const result = await userTerminalRead.run(
        { id: opened.id, lines: 5 },
        execFor(service, "screen-owner", dir),
      );
      return result.text.includes("red plain") ? result : null;
    });
    assert.equal(read.isError, undefined);
    assert.match(read.text, /red plain/);
    assert.doesNotMatch(read.text, /\x1b\[31m/);
    assert.match(read.meta.sessionId, /term_/);
  } finally {
    service.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
