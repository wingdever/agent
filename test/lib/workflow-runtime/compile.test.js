"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { compileScript, WorkflowError } from "../../../lib/workflow-runtime/index.js";

test("compileScript accepts a plain async body with top-level await", () => {
  assert.doesNotThrow(() => compileScript("const x = await Promise.resolve(1); return x;", "smoke"));
});

test("compileScript rejects a body that does not parse", () => {
  assert.throws(
    () => compileScript("return {", "broken"),
    (error) => error instanceof WorkflowError && error.code === "SCRIPT_PARSE",
  );
});
