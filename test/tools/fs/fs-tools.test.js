"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import applyPatch from "../../../tools/apply_patch/run.js";
import strReplaceEditor from "../../../tools/str_replace_editor/run.js";
import readImage from "../../../tools/read_image/run.js";
import { loadTools } from "../../../core/tools/registry.js";
import { normalizeResult, modelContent } from "../../../lib/tool-result/index.js";
import { resolveFsPermissionForPaths, fsPathsForTool } from "../../../core/fs-policy.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fs-tools-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function exec(dir, extra = {}) {
  return { cwd: dir, sessionId: "fs-tools-test", ...extra };
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

test("the three filesystem tools are registered with the fs group", async () => {
  const tools = await loadTools();
  for (const name of ["apply_patch", "str_replace_editor", "read_image"]) {
    const tool = tools.get(name);
    assert.ok(tool, name + " should be registered");
    assert.equal(tool.group, "fs");
  }
  assert.equal(tools.get("apply_patch").mode, "write");
  assert.equal(tools.get("str_replace_editor").mode, "write");
  assert.equal(tools.get("read_image").mode, "read");
});

test("apply_patch adds, updates, moves and deletes files", async () => {
  const dir = tempDir();
  try {
    const patch = [
      "*** Begin Patch",
      "*** Add File: notes/one.txt",
      "+one",
      "+two",
      "*** Update File: notes/one.txt",
      "@@",
      " one",
      "-two",
      "+three",
      "*** Add File: notes/two.txt",
      "+alpha",
      "*** Update File: notes/two.txt",
      "*** Move to: notes/renamed.txt",
      "*** Delete File: notes/one.txt",
      "*** End Patch",
    ].join("\n");

    const result = await applyPatch.run({ input: patch }, exec(dir));
    assert.match(result.text, /A /);
    assert.match(result.text, /M /);
    assert.match(result.text, /D /);
    assert.equal(fs.existsSync(path.join(dir, "notes/one.txt")), false);
    assert.equal(fs.existsSync(path.join(dir, "notes/two.txt")), false);
    assert.equal(fs.readFileSync(path.join(dir, "notes/renamed.txt"), "utf8"), "alpha\n");
    assert.ok(Array.isArray(result.meta.files));
    assert.equal(result.meta.files.length, 6);
  } finally {
    cleanup(dir);
  }
});

test("apply_patch rejects the whole patch before writing when a later hunk is missing", async () => {
  const dir = tempDir();
  try {
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+created",
      "*** Update File: missing.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    await assert.rejects(() => applyPatch.run({ input: patch }, exec(dir)), /cannot update .*missing\.txt.*not found/);
    assert.equal(fs.existsSync(path.join(dir, "created.txt")), false, "validation failure must not write earlier files");
  } finally {
    cleanup(dir);
  }
});

test("apply_patch rejects an ambiguous hunk and does not modify the file", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "ambiguous.txt");
    fs.writeFileSync(file, "same\nsame\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: ambiguous.txt",
      "@@",
      "-same",
      "+changed",
      "*** End Patch",
    ].join("\n");
    await assert.rejects(() => applyPatch.run({ input: patch }, exec(dir)), /ambiguous/);
    assert.equal(fs.readFileSync(file, "utf8"), "same\nsame\n");
  } finally {
    cleanup(dir);
  }
});

test("apply_patch honors *** End of File", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "tail.txt");
    fs.writeFileSync(file, "a\nb\nc");
    const patch = [
      "*** Begin Patch",
      "*** Update File: tail.txt",
      "@@",
      "-b",
      "+B",
      "*** End of File",
      "*** End Patch",
    ].join("\n");
    await assert.rejects(() => applyPatch.run({ input: patch }, exec(dir)), /End of File anchor/);
    assert.equal(fs.readFileSync(file, "utf8"), "a\nb\nc");

    const good = [
      "*** Begin Patch",
      "*** Update File: tail.txt",
      "@@",
      "-c",
      "+C",
      "*** End of File",
      "*** End Patch",
    ].join("\n");
    await applyPatch.run({ input: good }, exec(dir));
    assert.equal(fs.readFileSync(file, "utf8"), "a\nb\nC");
  } finally {
    cleanup(dir);
  }
});

test("str_replace_editor creates, views, replaces and inserts", async () => {
  const dir = tempDir();
  try {
    const created = await strReplaceEditor.run({
      command: "create",
      path: "notes.txt",
      file_text: "one\ntwo\nthree\n",
    }, exec(dir));
    assert.match(created.text, /created successfully/);

    const view = await strReplaceEditor.run({ command: "view", path: "notes.txt" }, exec(dir));
    assert.match(view.text, /1: one/);
    assert.match(view.text, /3: three/);

    const range = await strReplaceEditor.run({
      command: "view",
      path: "notes.txt",
      view_range: [2, 2],
    }, exec(dir));
    assert.match(range.text, /2: two/);
    assert.doesNotMatch(range.text, /1: one/);

    await strReplaceEditor.run({
      command: "str_replace",
      path: "notes.txt",
      old_str: "two",
      new_str: "TWO",
    }, exec(dir));
    await strReplaceEditor.run({
      command: "insert",
      path: "notes.txt",
      insert_line: 2,
      new_str: "inserted",
    }, exec(dir));

    assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "one\nTWO\ninserted\nthree\n");
  } finally {
    cleanup(dir);
  }
});

test("str_replace_editor views directories and rejects duplicate replacements", async () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "x");
    const view = await strReplaceEditor.run({ command: "view", path: "." }, exec(dir));
    assert.match(view.text, /d sub\//);
    assert.match(view.text, /f sub\/nested\.txt/);

    fs.writeFileSync(path.join(dir, "dup.txt"), "x\nx\n");
    await assert.rejects(
      () => strReplaceEditor.run({ command: "str_replace", path: "dup.txt", old_str: "x", new_str: "y" }, exec(dir)),
      /matched 2 times/,
    );
  } finally {
    cleanup(dir);
  }
});

test("str_replace_editor create refuses to overwrite an existing path", async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "exists.txt"), "keep");
    await assert.rejects(
      () => strReplaceEditor.run({ command: "create", path: "exists.txt", file_text: "new" }, exec(dir)),
      /already exists/,
    );
    assert.equal(fs.readFileSync(path.join(dir, "exists.txt"), "utf8"), "keep");
  } finally {
    cleanup(dir);
  }
});

test("read_image returns an image content part and a durable attachment", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "one.png");
    fs.writeFileSync(file, PNG_1X1);
    const result = await readImage.run(
      { file_path: "one.png" },
      exec(dir, { attachmentRoot: path.join(dir, "attachments") }),
    );
    assert.match(result.text, /<media_type>image\/png<\/media_type>/);
    assert.match(result.text, /<dimensions>1x1<\/dimensions>/);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "image_url");
    assert.match(result.content[0].image_url.url, /^data:image\/png;base64,/);
    assert.ok(fs.existsSync(result.meta.attachmentPath));
    assert.equal(fs.statSync(result.meta.attachmentPath).size, PNG_1X1.length);
    assert.match(result.meta.attachmentId, /^att_/);
  } finally {
    cleanup(dir);
  }
});

test("read_image rejects non-image bytes even with an image extension", async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "fake.png"), "not an image");
    await assert.rejects(
      () => readImage.run({ file_path: "fake.png" }, exec(dir, { attachmentRoot: path.join(dir, "attachments") })),
      /unsupported image format/,
    );
  } finally {
    cleanup(dir);
  }
});

test("multimodal tool results keep their provider-ready content parts", () => {
  const normalized = normalizeResult({
    text: "image envelope",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
  });
  assert.equal(normalized.text, "image envelope");
  assert.equal(normalized.isError, false);
  assert.equal(normalized.content.length, 1);
  const content = modelContent(normalized);
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "image envelope");
  assert.equal(content[1].type, "image_url");
});

test("apply_patch paths are visible to fs-policy", () => {
  const paths = fsPathsForTool("apply_patch", {
    input: "*** Begin Patch\n*** Update File: secret/a.txt\n*** Move to: public/b.txt\n*** Delete File: old/c.txt\n*** End Patch",
  });
  assert.deepEqual(paths, ["secret/a.txt", "old/c.txt", "public/b.txt"]);

  const permissions = { default: "ask", tools: new Map([["apply_patch", "ask"]]) };
  const policy = { rules: [{ pattern: "secret/**", permission: "deny" }] };
  assert.equal(
    resolveFsPermissionForPaths(permissions, policy, "apply_patch", paths, "/workspace"),
    "deny",
  );
});

