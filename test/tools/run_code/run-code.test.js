"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { runProgram } from "../../../lib/code-runner/index.js";
import runCodeTool from "../../../tools/run_code/run.js";
import toolExecute from "../../../core/loops/nodes/tool-execute/run.js";
import { loadTools } from "../../../core/tools/registry.js";
import { resolveExecutorMode, selectForExecutor } from "../../../core/executor-mode.js";
import { assembleSystemPrompt } from "../../../core/system-prompt.js";
import { renderToolSdk } from "../../../lib/tool-sdk/index.js";

test("run_code is registered but hidden from the native default set", async () => {
  const tools = await loadTools();
  const tool = tools.get("run_code");
  assert.ok(tool);
  assert.equal(tool.mode, "write");
  assert.equal(tool.defaultVisible, false);
});

test("run_code validates code, description and timeout args", async () => {
  const calls = [];
  const ok = await runCodeTool.run(
    { code: "inspect('hi')", description: "say hi", timeoutMs: 0 },
    { runCode: async (request) => { calls.push(request); return { text: "ok" }; } },
  );
  assert.equal(ok.text, "ok");
  assert.equal(calls[0].timeoutMs, 120000);
  assert.equal(calls[0].description, "say hi");

  const capped = [];
  await runCodeTool.run(
    { code: "inspect('hi')", description: "cap", timeoutMs: 999999 },
    { runCode: async (request) => { capped.push(request); return { text: "ok" }; } },
  );
  assert.equal(capped[0].timeoutMs, 600000);

  const empty = await runCodeTool.run({ code: " ", description: "x" }, { runCode: async () => ({}) });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /code/);

  const unavailable = await runCodeTool.run({ code: "x", description: "x" }, {});
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.text, /unavailable/);
});

test("run_code executes TypeScript and reaches nested tools", async () => {
  const result = await runProgram({
    code: [
      "const parts: string[] = await tools.echo({ text: 'one' });",
      "const second = await tools.echo({ text: 'two' });",
      "inspect(parts, second);",
    ].join("\n"),
    description: "echo twice",
    timeoutMs: 5000,
    callTool: async ({ name, args }) => {
      assert.equal(name, "echo");
      return { text: "echo:" + args.text };
    },
  });
  assert.equal(result.text, "echo:one\necho:two");
  assert.equal(result.meta.description, "echo twice");
});

test("run_code turns nested tool errors into thrown errors the program can catch", async () => {
  const result = await runProgram({
    code: [
      "try { await tools.fail({}); } catch (error) { inspect('caught: ' + error.message); }",
    ].join("\n"),
    description: "catch tool error",
    timeoutMs: 5000,
    callTool: async () => ({ text: "Error: boom", isError: true }),
  });
  assert.equal(result.text, "caught: boom");
});

test("run_code keeps image content parts from inspect", async () => {
  const result = await runProgram({
    code: "inspect({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });",
    description: "show image",
    timeoutMs: 5000,
    callTool: async () => ({ text: "" }),
  });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "image_url");
  assert.match(result.content[0].image_url.url, /^data:image\/png;base64,/);
});

test("run_code starts with an empty environment and a fresh process", async () => {
  const result = await runProgram({
    code: "inspect(Object.keys(process.env).length);",
    description: "check env",
    timeoutMs: 5000,
    callTool: async () => ({ text: "" }),
  });
  assert.equal(result.text, "0");
});

test("run_code rejects a syntax error and a timeout", async () => {
  await assert.rejects(() => runProgram({
    code: "const = 1;",
    description: "bad syntax",
    timeoutMs: 5000,
  }), /Unexpected token|Invalid|SyntaxError|expected/i);

  await assert.rejects(() => runProgram({
    code: "while (true) {}",
    description: "spin",
    timeoutMs: 100,
  }), /timed out after 100 ms/);
});

test("run_code rejects immediately when the caller is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runProgram({
    code: "inspect('never');",
    description: "aborted",
    timeoutMs: 5000,
    signal: controller.signal,
  }), /aborted/);
});

test("tool-execute wires nested run_code calls through the normal tool path", async () => {
  const tools = await loadTools();
  const runCode = tools.get("run_code");
  const echo = {
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    mode: "read",
    group: "utility",
    run: async (args) => ({ text: "echo:" + args.text }),
  };
  const toolMap = new Map([["run_code", runCode], ["echo", echo]]);
  const toolsService = {
    get: (name) => toolMap.get(name),
    select: (names) => (names ? names.map((name) => toolMap.get(name)).filter(Boolean) : [...toolMap.values()]),
  };
  const events = [];
  const ctx = {
    agent: { turn: { activity: "chat", autonomy: "supervised" }, planPolicyActive: () => false },
    services: {
      tools: toolsService,
      interactions: { requestApproval: async () => "approve" },
    },
    session: { id: 1, persist: false },
    step: {
      response: {
        tool_calls: [{
          id: "call-1",
          function: {
            name: "run_code",
            arguments: JSON.stringify({
              code: "inspect(await tools.echo({ text: 'hi' }));",
              description: "echo hi",
            }),
          },
        }],
      },
      callIds: [],
    },
    request: {
      messages: [],
      selected: [runCode],
      nestedToolNames: ["echo"],
      permissions: { default: "allow", tools: new Map() },
      fsPolicy: null,
      model: "test",
      effort: null,
      stream: false,
    },
    turn: { steps: 0, stepSeq: 0, toolsUsed: 0 },
    cwd: "/tmp",
    emit: (event) => events.push(event),
    signal: undefined,
  };
  const result = await toolExecute({}, ctx);
  assert.equal(result.next, "decide-next");
  const toolMessage = ctx.request.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.content, "echo:hi");
  assert.ok(events.some((event) => event.type === "tool_call" && event.nested === true && event.name === "echo"));
  assert.ok(events.some((event) => event.type === "tool_result" && event.nested === true && event.name === "echo"));
});

test("PTC selection exposes only run_code and keeps the native tools nested", () => {
  const tools = new Map([
    ["read", { name: "read", defaultVisible: true }],
    ["write", { name: "write", defaultVisible: true }],
    ["run_code", { name: "run_code", defaultVisible: false }],
    ["hidden", { name: "hidden", defaultVisible: false }],
  ]);
  const service = {
    select(names) {
      return (names ? names.map((name) => tools.get(name)).filter(Boolean) : [...tools.values()].filter((tool) => tool.defaultVisible))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    get(name) { return tools.get(name); },
  };
  const ptc = selectForExecutor(service, undefined, "ptc");
  assert.deepEqual(ptc.selected.map((tool) => tool.name), ["run_code"]);
  assert.deepEqual(ptc.nestedToolNames, ["read", "write"]);
  assert.deepEqual(ptc.sdkTools.map((tool) => tool.name), ["read", "write"]);

  const native = selectForExecutor(service, ["read"], "native");
  assert.deepEqual(native.selected.map((tool) => tool.name), ["read"]);
  assert.deepEqual(native.nestedToolNames, ["read"]);
});

test("the PTC executor contributes run_code policy and an SDK section", () => {
  assert.equal(resolveExecutorMode(undefined), "native");
  assert.equal(resolveExecutorMode("ptc"), "ptc");
  const sdk = renderToolSdk([
    { name: "read", description: "Read a text file.", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  ]);
  assert.match(sdk, /read\(args: \{/);
  assert.match(sdk, /file_path: string;/);
  const prompt = assembleSystemPrompt({
    tools: [{ name: "run_code", prompt: "" }],
    executorMode: "ptc",
    sdkTools: [
      { name: "read", description: "Read a text file.", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    ],
    cwd: "/tmp",
  });
  assert.ok(prompt.sections.some((section) => section.name === "tools:ptc-only"));
  assert.match(prompt.system, /`run_code` is the only tool/);
  assert.match(prompt.system, /declare const tools: RunCodeTools;/);
  assert.doesNotMatch(prompt.system, /tool:read/);
});
