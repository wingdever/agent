"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalService } from "../../../lib/terminals/index.js";
import { loadTools } from "../../../core/tools/registry.js";
import terminalOpen from "../../../tools/terminal_open/run.js";
import terminalList from "../../../tools/terminal_list/run.js";
import terminalRead from "../../../tools/terminal_read/run.js";
import terminalSend from "../../../tools/terminal_send/run.js";
import terminalSignal from "../../../tools/terminal_signal/run.js";
import terminalClose from "../../../tools/terminal_close/run.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "terminal-tools-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

function execFor(service, sessionId, cwd, extra = {}) {
  return { sessionId, cwd, terminals: service, ...extra };
}

async function waitForOutput(service, owner, sessionId, pattern, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = service.read(owner, sessionId, { count: 500 });
    if (pattern.test(result.text)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("terminal output did not match " + pattern);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

test("the terminal family registers six tools in one prompt section", async () => {
  const tools = await loadTools();
  const names = ["terminal_open", "terminal_list", "terminal_read", "terminal_send", "terminal_signal", "terminal_close"];
  for (const name of names) {
    const tool = tools.get(name);
    assert.ok(tool, name + " is registered");
    assert.equal(tool.group, "terminal");
    assert.equal(tool.defaultVisible, true);
    assert.equal(tool.promptSection, "pty");
  }
  assert.deepEqual(
    Object.keys(tools.get("terminal_open").parameters.properties).sort(),
    ["cwd", "name", "type"],
  );
  assert.deepEqual(
    Object.keys(tools.get("terminal_list").parameters.properties),
    [],
  );
  assert.deepEqual(
    Object.keys(tools.get("terminal_read").parameters.properties).sort(),
    ["count", "offset", "sessionId"],
  );
  assert.deepEqual(
    Object.keys(tools.get("terminal_send").parameters.properties).sort(),
    ["run_in_background", "sessionId", "submit", "text"],
  );
  assert.deepEqual(
    Object.keys(tools.get("terminal_signal").parameters.properties).sort(),
    ["sessionId", "signal"],
  );
  assert.deepEqual(
    Object.keys(tools.get("terminal_close").parameters.properties),
    ["sessionId"],
  );
});

test("open, list, send and read share one PTY session", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell", name: "main" }, execFor(service, "terminal-basic", dir));
    assert.equal(opened.isError, undefined);
    assert.match(opened.text, /Opened terminal term_/);
    assert.equal(opened.meta.cwd, dir);

    const listed = await terminalList.run({}, execFor(service, "terminal-basic", dir));
    assert.equal(listed.meta.count, 1);
    assert.match(listed.text, /main/);
    assert.match(listed.text, /running/);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const sent = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "printf 'alpha\\n'; printf 'beta\\n' >&2; pwd" },
      execFor(service, "terminal-basic", dir),
    );
    assert.match(sent.text, /alpha/);
    assert.match(sent.text, /beta/);
    assert.match(sent.text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(sent.meta.reason, "prompt");

    const read = await terminalRead.run(
      { sessionId: opened.meta.sessionId, count: 20 },
      execFor(service, "terminal-basic", dir),
    );
    assert.match(read.text, /alpha/);
    assert.equal(read.meta.sessionId, opened.meta.sessionId);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("terminal sessions are isolated by owner", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell" }, execFor(service, "owner-a", dir));
    const otherList = await terminalList.run({}, execFor(service, "owner-b", dir));
    assert.equal(otherList.meta.count, 0);
    const otherRead = await terminalRead.run(
      { sessionId: opened.meta.sessionId },
      execFor(service, "owner-b", dir),
    );
    assert.equal(otherRead.isError, true);
    assert.match(otherRead.text, /no persistent terminal/);
    await assert.rejects(
      () => service.closeTerminal("owner-b", opened.meta.sessionId),
      /no persistent terminal/,
    );
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("terminal_read pages newest lines and supports offsets", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell" }, execFor(service, "terminal-read", dir));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "for i in 1 2 3 4 5; do echo line-$i; done" },
      execFor(service, "terminal-read", dir),
    );

    const page = await terminalRead.run(
      { sessionId: opened.meta.sessionId, count: 2 },
      execFor(service, "terminal-read", dir),
    );
    assert.match(page.text, /line-5/);
    assert.match(page.text, /dsh> /);

    const older = await terminalRead.run(
      { sessionId: opened.meta.sessionId, offset: 2, count: 2 },
      execFor(service, "terminal-read", dir),
    );
    assert.match(older.text, /line-3/);
    assert.match(older.text, /line-4/);
    assert.equal(older.meta.offset, 2);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("terminal_send drives interactive stdin across calls", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell" }, execFor(service, "terminal-stdin", dir));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const prompt = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "read -p 'name? ' REPLY" },
      execFor(service, "terminal-stdin", dir),
    );
    assert.match(prompt.text, /name\?/);

    const answer = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "Ada" },
      execFor(service, "terminal-stdin", dir),
    );
    assert.equal(answer.isError, undefined);

    const result = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "printf 'got:%s\\n' \"$REPLY\"" },
      execFor(service, "terminal-stdin", dir),
    );
    assert.match(result.text, /got:Ada/);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("terminal_send can write without submitting Enter", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell" }, execFor(service, "terminal-nosubmit", dir));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const partial = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "printf 'not-run'", submit: false },
      execFor(service, "terminal-nosubmit", dir),
    );
    assert.equal(partial.isError, undefined);
    assert.equal(partial.meta.reason, "sent");

    await new Promise((resolve) => setTimeout(resolve, 250));
    const read = await terminalRead.run(
      { sessionId: opened.meta.sessionId, count: 10 },
      execFor(service, "terminal-nosubmit", dir),
    );
    assert.match(read.text, /not-run/);
    assert.doesNotMatch(read.text, /not-runnot-run/);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("terminal_signal targets the foreground process group and rejects shell SIGKILL", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell" }, execFor(service, "terminal-signal", dir));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const shellKill = await terminalSignal.run(
      { sessionId: opened.meta.sessionId, signal: "SIGKILL" },
      execFor(service, "terminal-signal", dir),
    );
    assert.equal(shellKill.isError, true);
    assert.match(shellKill.text, /refusing SIGKILL/);

    await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "sleep 10" },
      execFor(service, "terminal-signal", dir),
    );
    await waitForOutput(service, "terminal-signal", opened.meta.sessionId, /sleep 10/);
    const interrupted = await terminalSignal.run(
      { sessionId: opened.meta.sessionId, signal: "SIGINT" },
      execFor(service, "terminal-signal", dir),
    );
    assert.equal(interrupted.isError, undefined);
    assert.equal(interrupted.meta.signal, "SIGINT");

    await waitForOutput(service, "terminal-signal", opened.meta.sessionId, /dsh> /);
    const after = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "printf 'after-signal\\n'" },
      execFor(service, "terminal-signal", dir),
    );
    assert.match(after.text, /after-signal/);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("terminal_close waits for the captured process tree to disappear", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell" }, execFor(service, "terminal-close", dir));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const started = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "sleep 30 & echo CHILD:$!" },
      execFor(service, "terminal-close", dir),
    );
    const match = started.text.match(/CHILD:(\d+)/);
    assert.ok(match, started.text);
    const childPid = Number(match[1]);
    assert.equal(alive(childPid), true);

    const closed = await terminalClose.run(
      { sessionId: opened.meta.sessionId },
      execFor(service, "terminal-close", dir),
    );
    assert.equal(closed.isError, undefined);
    assert.equal(closed.meta.gone, true);
    assert.ok(closed.meta.captured.includes(childPid));
    assert.equal(alive(childPid), false);
    assert.equal(service.list("terminal-close").length, 0);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("background terminal_send returns a job id and appends terminal output", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "shell" }, execFor(service, "terminal-background", dir));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const appended = [];
    let completed = null;
    const startJob = async (spec) => {
      const job = { append: (line) => appended.push(line) };
      Promise.resolve(spec.run(job)).then(async (started) => {
        completed = await started.done;
      }).catch((error) => {
        completed = { status: "failed", detail: error.message };
      });
      return { jobId: "job_terminal_test" };
    };
    const sent = await terminalSend.run(
      { sessionId: opened.meta.sessionId, text: "printf 'background-output\\n'", run_in_background: true },
      execFor(service, "terminal-background", dir, { startJob }),
    );
    assert.equal(sent.isError, undefined);
    assert.equal(sent.meta.job_id, "job_terminal_test");
    const started = Date.now();
    while (Date.now() - started < 3000 && !completed) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(appended.join("\n"), /background-output/);
    assert.equal(completed.status, "completed");
    assert.equal(completed.detail, "prompt");
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("opening an unknown backend type is rejected without spawning a process", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const opened = await terminalOpen.run({ type: "python" }, execFor(service, "terminal-type", dir));
    assert.equal(opened.isError, true);
    assert.match(opened.text, /unknown terminal backend type/);
    assert.equal(service.list("terminal-type").length, 0);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});
