"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bashPersistent from "../../../tools/bash-persistent/run.js";
import { TerminalService } from "../../../lib/terminals/index.js";
import { loadTools } from "../../../core/tools/registry.js";
import toolExecute from "../../../core/loops/nodes/tool-execute/run.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bash-persistent-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

test("bash has one registered slot and defaults to the persistent provider", async () => {
  const tools = await loadTools();
  const bash = tools.get("bash");
  assert.ok(bash);
  assert.equal(bash.provider, "persistent");
  assert.deepEqual(Object.keys(bash.parameters.properties), ["command"]);
  assert.match(bash.description, /persistent bash shell/);

  const foreground = await loadTools({ providers: { bash: "foreground" }, env: {} });
  assert.equal(foreground.get("bash").provider, "foreground");
  assert.deepEqual(Object.keys(foreground.get("bash").parameters.properties).sort(), [
    "command", "description", "timeoutMs", "workdir",
  ]);
});

test("persistent bash keeps cwd and exported environment across calls", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const first = await bashPersistent.run(
      { command: "pwd" },
      { sessionId: "persistent-state", cwd: dir, callId: "p1", terminals: service },
    );
    assert.equal(first.meta.kind, "persistent");
    assert.equal(first.meta.cwd, dir);
    assert.match(first.text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await bashPersistent.run(
      { command: "cd .. && export DSH_PERSIST_TEST=kept" },
      { sessionId: "persistent-state", cwd: dir, callId: "p2", terminals: service },
    );
    const second = await bashPersistent.run(
      { command: "pwd; printf '%s\\n' \"$DSH_PERSIST_TEST\"" },
      { sessionId: "persistent-state", cwd: dir, callId: "p3", terminals: service },
    );
    assert.equal(second.meta.cwd, path.dirname(dir));
    assert.match(second.text, /kept/);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("persistent bash reports stdout, stderr and exit status", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const result = await bashPersistent.run(
      { command: "printf 'out\\n'; printf 'err\\n' >&2; false" },
      { sessionId: "persistent-streams", cwd: dir, callId: "p4", terminals: service },
    );
    assert.equal(result.text, "out\n[stderr]\nerr\n[exit code: 1]");
    assert.equal(result.meta.exitCode, 1);
    assert.equal(result.meta.stdout.text, "out\n");
    assert.equal(result.meta.stderr.text, "err\n");
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("a timed out command destroys the shell and the next call starts clean", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const before = await bashPersistent.run(
      { command: "pwd" },
      { sessionId: "persistent-timeout", cwd: dir, callId: "p5", terminals: service },
    );
    assert.equal(before.meta.cwd, dir);

    // The tool's public timeout is fixed; drive the terminal directly to keep
    // this test fast.
    await assert.rejects(
      () => service.run("persistent-timeout", "sleep 5", { cwd: dir, timeoutMs: 100 }),
      /timed out after 100ms/,
    );

    const after = await bashPersistent.run(
      { command: "pwd" },
      { sessionId: "persistent-timeout", cwd: dir, callId: "p6", terminals: service },
    );
    assert.equal(after.meta.cwd, dir);
    assert.equal(after.text.trim(), dir);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("an aborted command rejects and does not leave a busy shell", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  const controller = new AbortController();
  try {
    const pending = service.run("persistent-abort", "sleep 5", {
      cwd: dir,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(() => pending, /aborted/);

    const next = await bashPersistent.run(
      { command: "pwd" },
      { sessionId: "persistent-abort", cwd: dir, callId: "p7", terminals: service },
    );
    assert.equal(next.text.trim(), dir);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("shell options and stdout redirection do not hide the completion marker", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const setE = await bashPersistent.run(
      { command: "set -e; false; echo after" },
      { sessionId: "persistent-redirect", cwd: dir, callId: "p8", terminals: service },
    );
    assert.equal(setE.meta.exitCode, 0);
    assert.equal(setE.text, "after\n");

    const redirect = path.join(dir, "redirected.txt");
    const hidden = await bashPersistent.run(
      { command: "exec > " + JSON.stringify(redirect) + "; echo hidden" },
      { sessionId: "persistent-redirect", cwd: dir, callId: "p9", terminals: service },
    );
    assert.equal(hidden.meta.exitCode, 0);
    assert.equal(hidden.text, "(no output)");
    assert.equal(fs.readFileSync(redirect, "utf8"), "hidden\n");
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("PTC run_code can reach the persistent bash provider through the normal tool path", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    const registered = await loadTools();
    const runCode = registered.get("run_code");
    const bash = registered.get("bash");
    const tools = new Map([["run_code", runCode], ["bash", bash]]);
    const toolsService = {
      get: (name) => tools.get(name),
      select: (names) => (names ? names.map((name) => tools.get(name)).filter(Boolean) : [...tools.values()]),
    };
    const events = [];
    const ctx = {
      agent: { turn: { activity: "chat", autonomy: "supervised" }, planPolicyActive: () => false },
      services: {
        tools: toolsService,
        terminals: service,
        interactions: { requestApproval: async () => "approve" },
      },
      session: { id: "persistent-ptc", persist: false },
      step: {
        response: {
          tool_calls: [{
            id: "call-ptc",
            function: {
              name: "run_code",
              arguments: JSON.stringify({
                code: "inspect(await tools.bash({command: 'pwd'}));",
                description: "persistent bash through PTC",
              }),
            },
          }],
        },
        callIds: [],
      },
      request: {
        messages: [],
        selected: [runCode],
        nestedToolNames: ["bash"],
        permissions: { default: "allow", tools: new Map() },
        fsPolicy: null,
        model: "test",
        effort: null,
        stream: false,
      },
      turn: { steps: 0, stepSeq: 0, toolsUsed: 0 },
      cwd: dir,
      emit: (event) => events.push(event),
      signal: undefined,
    };

    await toolExecute({}, ctx);
    const toolMessage = ctx.request.messages.find((message) => message.role === "tool");
    assert.equal(toolMessage.content.trim(), dir);
    assert.ok(events.some((event) => event.type === "tool_call" && event.nested === true && event.name === "bash"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.nested === true && event.name === "bash"));
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("persistent bash defaults to a real PTY and reports the backend", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, logger: quietLogger() });
  try {
    assert.equal(service.backend, "pty");
    const tty = await service.run(
      "persistent-tty",
      "if [ -t 0 ] && [ -t 1 ]; then printf 'tty\\n'; else printf 'notty\\n'; fi",
      { cwd: dir },
    );
    assert.equal(tty.backend, "pty");
    assert.equal(tty.exitCode, 0);
    assert.equal(tty.stdout, "tty\n");
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("pipe backend remains available and has no terminal", async () => {
  const dir = tempDir();
  const service = new TerminalService({ idleTimeoutMs: 0, backend: "pipe", logger: quietLogger() });
  try {
    assert.equal(service.backend, "pipe");
    const tty = await service.run(
      "persistent-pipe",
      "if [ -t 0 ] && [ -t 1 ]; then printf 'tty\\n'; else printf 'notty\\n'; fi",
      { cwd: dir },
    );
    assert.equal(tty.backend, "pipe");
    assert.equal(tty.stdout, "notty\n");

    const streams = await service.run(
      "persistent-pipe",
      "printf 'out\\n'; printf 'err\\n' >&2; false",
      { cwd: dir },
    );
    assert.equal(streams.stdout, "out\n");
    assert.equal(streams.stderr, "err\n");
    assert.equal(streams.exitCode, 1);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("a PTY start failure falls back to the pipe backend", async () => {
  const dir = tempDir();
  const service = new TerminalService({
    idleTimeoutMs: 0,
    backend: "pty",
    ptyModule: { spawn() { throw new Error("forced pty failure"); } },
    logger: quietLogger(),
  });
  try {
    const result = await service.run("persistent-fallback", "pwd", { cwd: dir });
    assert.equal(result.backend, "pipe");
    assert.equal(result.stdout.trim(), dir);
  } finally {
    service.disposeAll();
    cleanup(dir);
  }
});

test("persistent bash rejects an empty command and requires the terminal service", async () => {
  await assert.rejects(
    () => bashPersistent.run({ command: " " }, { sessionId: "x", cwd: "/tmp" }),
    /non-empty string/,
  );
  const noService = await bashPersistent.run({ command: "pwd" }, { sessionId: "x", cwd: "/tmp" });
  assert.equal(noService.isError, true);
  assert.match(noService.text, /terminal service/);
});
