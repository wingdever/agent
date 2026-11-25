"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTools } from "../../../core/tools/registry.js";
import presentTool, { MAX_FILES, relativeDisplay } from "../../../tools/present/run.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "present-tools-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("present is a visible, read-only deliverable tool with the DSH files contract", async () => {
  const tools = await loadTools();
  const tool = tools.get("present");
  assert.ok(tool);
  assert.equal(tool.group, "deliverable");
  assert.equal(tool.mode, "read");
  assert.equal(tool.defaultVisible, true);
  assert.equal(tool.concurrencySafe, true);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["files"]);
  assert.equal(tool.parameters.properties.files.type, "array");
  assert.equal(tool.parameters.properties.files.items.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.files.items.required, ["path"]);
  assert.match(tool.description, /final deliverables/);
});

test("presents relative paths under cwd and returns durable file meta", async () => {
  const dir = tempDir();
  const report = path.join(dir, "report.md");
  const chart = path.join(dir, "chart.png");
  fs.writeFileSync(report, "# report\n");
  fs.writeFileSync(chart, "PNG");
  try {
    const result = await presentTool.run({
      files: [
        { path: "report.md", description: "Q3 report" },
        { path: chart },
      ],
    }, { cwd: dir });

    assert.equal(result.meta.files.length, 2);
    assert.equal(result.meta.files[0].path, report);
    assert.equal(result.meta.files[0].display, "report.md");
    assert.equal(result.meta.files[0].name, "report.md");
    assert.equal(result.meta.files[0].description, "Q3 report");
    assert.equal(result.meta.files[0].bytes, 9);
    assert.equal(result.meta.files[1].path, chart);
    assert.equal(result.meta.files[1].display, "chart.png");
    assert.match(result.text, /Presented 2 files to the user/);
    assert.match(result.text, /report\.md — Q3 report/);
    assert.match(result.text, /contents are not copied/);
  } finally {
    cleanup(dir);
  }
});

test("keeps absolute paths outside cwd explicit in the model-facing text", async () => {
  const dir = tempDir();
  const outside = path.join(os.tmpdir(), "present-outside-" + process.pid + ".txt");
  fs.writeFileSync(outside, "outside");
  try {
    assert.equal(relativeDisplay(outside, dir), outside);
    const result = await presentTool.run({ files: [{ path: outside }] }, { cwd: dir });
    assert.equal(result.meta.files[0].display, outside);
    assert.match(result.text, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    cleanup(dir);
    fs.rmSync(outside, { force: true });
  }
});

test("rejects empty, oversized and invalid file lists", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "a");
  try {
    await assert.rejects(
      presentTool.run({ files: [] }, { cwd: dir }),
      /at least one file/,
    );
    await assert.rejects(
      presentTool.run({ files: Array.from({ length: MAX_FILES + 1 }, () => ({ path: "a.txt" })) }, { cwd: dir }),
      /at most 4 files/,
    );
    await assert.rejects(
      presentTool.run({ files: [{ path: "" }] }, { cwd: dir }),
      /files\[0\]\.path must be a non-empty string/,
    );
    await assert.rejects(
      presentTool.run({ files: [{ path: "a.txt", description: 42 }] }, { cwd: dir }),
      /files\[0\]\.description must be a string/,
    );
  } finally {
    cleanup(dir);
  }
});

test("rejects missing paths and directories before returning any delivery", async () => {
  const dir = tempDir();
  const subdir = path.join(dir, "folder");
  fs.mkdirSync(subdir);
  try {
    await assert.rejects(
      presentTool.run({ files: [{ path: "missing.txt" }] }, { cwd: dir }),
      /cannot present .*missing\.txt.*not found/,
    );
    await assert.rejects(
      presentTool.run({ files: [{ path: subdir }] }, { cwd: dir }),
      /cannot present .*folder.*not a regular file/,
    );
  } finally {
    cleanup(dir);
  }
});
