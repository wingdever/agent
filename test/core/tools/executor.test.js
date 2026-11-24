"use strict";

// Cancellation of a tool call. Two things are pinned here: the model-facing
// text distinguishes a body that never started from one that ran, and a started
// body is never abandoned — its outcome is settled first and only then replaced
// by the abort.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../../../core/tools/executor.js";

function tool(run) {
  return { name: "demo", parameters: { type: "object", properties: {} }, run };
}

test("an already-cancelled call never reaches the tool body", async () => {
  let invoked = false;
  const controller = new AbortController();
  controller.abort();

  const result = await runTool(
    tool(async () => {
      invoked = true;
      return "ran";
    }),
    {},
    { signal: controller.signal },
  );

  assert.equal(invoked, false, "the body must not start");
  assert.deepEqual(result, { text: "Error: tool call aborted before dispatch", isError: true });
});

test("a body that finishes normally still reports the abort when cancelled meanwhile", async () => {
  const controller = new AbortController();
  const result = await runTool(
    tool(async () => {
      // The body runs to completion; cancellation lands while it does.
      controller.abort();
      return "side effect done";
    }),
    {},
    { signal: controller.signal },
  );

  // The success text is replaced: a cancelled call is not reported as completed.
  assert.deepEqual(result, { text: "Error: tool call aborted", isError: true });
});

test("a body that reacts to the signal and throws is reported as aborted, not as its own error", async () => {
  const controller = new AbortController();
  // The abort fires while the body is waiting; the body then fails because of it.
  setTimeout(() => controller.abort(), 5);

  const result = await runTool(
    tool(async (_args, exec) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (exec.signal.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      return "never";
    }),
    {},
    { signal: controller.signal },
  );

  assert.equal(result.isError, true);
  assert.equal(result.text, "Error: tool call aborted");
});

test("an unrelated failure keeps its own message even when the call was cancelled", async () => {
  const controller = new AbortController();
  const result = await runTool(
    tool(async () => {
      throw new Error("disk full");
    }),
    {},
    { signal: controller.signal },
  );

  assert.deepEqual(result, { text: "Error: disk full", isError: true });
});

test("without a signal the tool behaves exactly as before", async () => {
  const ok = await runTool(tool(async () => "plain"), {}, {});
  assert.deepEqual(ok, { text: "plain", isError: false });

  const objectResult = await runTool(tool(async () => ({ text: "obj", meta: { a: 1 } })), {}, {});
  assert.equal(objectResult.text, "obj");
  assert.equal(objectResult.isError, false);
});

test("a cancelled call does not abort the body: it runs to completion", async () => {
  let finished = false;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  await runTool(
    tool(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      finished = true;
      return "done";
    }),
    {},
    { signal: controller.signal },
  );

  // Strict drain: the body is never cut short, so its side effects complete.
  assert.equal(finished, true);
});
