"use strict";

// str_replace_editor: view / create / str_replace / insert over one file.
// It is intentionally outside fs-observation: DSH's read-before-write policy
// covers read/write/edit, not this editor.

import fs from "fs";
import path from "path";
import {
  resolveFilePath,
  statFile,
  readTextFile,
  atomicWrite,
  ensureParent,
  splitLines,
  joinLines,
  fileChangeMeta,
  lineView,
} from "./../lib/fs-edit.js";
import { record } from "./../../lib/fs-observe/index.js";

const MAX_VIEW_LINES = 2000;
const MAX_VIEW_BYTES = 50 * 1024;

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(name + " must be a non-empty string");
  return value;
}

function parseViewRange(value, totalLines) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[0]) || !Number.isInteger(value[1])) {
    throw new Error("view_range must be [start_line, end_line]");
  }
  const start = value[0];
  const end = value[1];
  if (start < 1) throw new Error("view_range start_line must be >= 1");
  if (end !== -1 && end < start) throw new Error("view_range end_line must be -1 or >= start_line");
  if (start > totalLines && !(totalLines === 0 && start === 1)) {
    throw new Error("view_range start_line is past the end of the file (" + totalLines + " lines)");
  }
  return { start, end: end === -1 ? totalLines : Math.min(end, totalLines) };
}

async function listDirectory(root) {
  const entries = [];
  async function walk(dir, depth, prefix) {
    if (depth < 0) return;
    let children;
    try {
      children = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error('cannot view "' + dir + '": ' + (error.message || String(error)));
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name.startsWith(".")) continue;
      const rel = prefix ? prefix + "/" + child.name : child.name;
      if (child.isDirectory()) {
        entries.push('d ' + rel + "/");
        if (depth > 0) await walk(path.join(dir, child.name), depth - 1, rel);
      } else if (child.isFile()) {
        entries.push("f " + rel);
      }
    }
  }
  await walk(root, 2, "");
  return entries;
}

function formatFileView(displayPath, view, range) {
  const body = view.text || "(empty file)";
  const footer = range
    ? "(Showing lines " + range.start + "-" + Math.max(range.start, range.end) + " of " + view.totalLines + ")"
    : "(End of file - total " + view.totalLines + " lines)";
  return "<path>" + displayPath + "</path>\n<type>file</type>\n<content>\n" + body + "\n\n" + footer + "\n</content>";
}

function formatDirectoryView(displayPath, entries) {
  const body = entries.length ? entries.join("\n") : "(empty directory)";
  return "<path>" + displayPath + "</path>\n<type>directory</type>\n<content>\n" + body + "\n</content>";
}

async function runView(input) {
  const displayPath = resolveFilePath(input.path, input.cwd, "path");
  const info = await statFile(displayPath, "view");
  if (info.isDirectory()) {
    if (input.viewRange) throw new Error("view_range is only valid for a file");
    return { text: formatDirectoryView(displayPath, await listDirectory(displayPath)), meta: { path: displayPath, type: "directory" } };
  }
  if (!info.isFile()) throw new Error('cannot view "' + displayPath + '": not a regular file');
  const { text } = await readTextFile(displayPath, { verb: "view" });
  const { lines } = splitLines(text);
  const range = parseViewRange(input.viewRange, lines.length);
  let view;
  if (range) {
    view = lineView(text, range.start, range.end);
  } else {
    const maxLines = Math.min(lines.length, MAX_VIEW_LINES);
    view = lineView(text, 1, maxLines);
    if (lines.length > MAX_VIEW_LINES) {
      view.text += "\n\n(Showing lines 1-" + MAX_VIEW_LINES + " of " + lines.length + "; use view_range to continue.)";
    }
  }
  if (Buffer.byteLength(view.text, "utf8") > MAX_VIEW_BYTES) {
    const truncated = view.text.slice(0, MAX_VIEW_BYTES);
    view.text = truncated + "\n\n(Output capped at " + MAX_VIEW_BYTES + " bytes; use a narrower view_range.)";
  }
  return { text: formatFileView(displayPath, view, range), meta: { path: displayPath, type: "file", totalLines: view.totalLines } };
}

async function runCreate(input) {
  const displayPath = resolveFilePath(input.path, input.cwd, "path");
  if (input.fileText == null) throw new Error("file_text is required for create");
  if (typeof input.fileText !== "string") throw new Error("file_text must be a string");
  let exists = false;
  try {
    await fs.promises.stat(displayPath);
    exists = true;
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw new Error('cannot create "' + displayPath + '": ' + (error.message || String(error)));
    }
  }
  if (exists) throw new Error('cannot create "' + displayPath + '": path already exists');
  await ensureParent(displayPath);
  await atomicWrite(displayPath, input.fileText, 0o666);
  const info = await statFile(displayPath, "create");
  record(input.sessionId, displayPath, info);
  return {
    text: "File created successfully at: " + displayPath,
    meta: { path: displayPath, files: [fileChangeMeta(displayPath, "add", null, input.fileText)] },
  };
}

async function runStrReplace(input) {
  const displayPath = resolveFilePath(input.path, input.cwd, "path");
  const oldStr = requiredString(input.oldStr, "old_str");
  if (input.newStr != null && typeof input.newStr !== "string") throw new Error("new_str must be a string or null");
  const { text, info } = await readTextFile(displayPath, { verb: "edit" });
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error('old_str was not found in "' + displayPath + '"');
  if (count > 1) {
    throw new Error('old_str matched ' + count + ' times in "' + displayPath + '"; include more context to make it unique');
  }
  const replacement = input.newStr == null ? "" : input.newStr;
  const updated = text.replace(oldStr, replacement);
  await atomicWrite(displayPath, updated, info.mode & 0o777);
  const after = await statFile(displayPath, "edit");
  record(input.sessionId, displayPath, after);
  return {
    text: "The file " + displayPath + " has been edited successfully.",
    meta: { path: displayPath, files: [fileChangeMeta(displayPath, "update", text, updated)] },
  };
}

async function runInsert(input) {
  const displayPath = resolveFilePath(input.path, input.cwd, "path");
  if (!Number.isInteger(input.insertLine) || input.insertLine < 0) {
    throw new Error("insert_line must be an integer >= 0");
  }
  if (typeof input.newStr !== "string") throw new Error("new_str must be a string for insert");
  const { text, info } = await readTextFile(displayPath, { verb: "edit" });
  const parts = splitLines(text);
  if (input.insertLine > parts.lines.length) {
    throw new Error('insert_line ' + input.insertLine + ' is past the end of "' + displayPath + '" (' + parts.lines.length + " lines)");
  }
  const inserted = parts.lines.slice();
  inserted.splice(input.insertLine, 0, ...input.newStr.split("\n"));
  const updated = joinLines(inserted, parts.trailingNewline || input.insertLine === parts.lines.length);
  await atomicWrite(displayPath, updated, info.mode & 0o777);
  const after = await statFile(displayPath, "edit");
  record(input.sessionId, displayPath, after);
  return {
    text: "The file " + displayPath + " has been edited successfully.",
    meta: { path: displayPath, files: [fileChangeMeta(displayPath, "update", text, updated)] },
  };
}

export default {
  async run(args = {}, exec = {}) {
    const command = args.command;
    if (!["view", "create", "str_replace", "insert"].includes(command)) {
      throw new Error("command must be one of view, create, str_replace, insert");
    }
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path must be a non-empty string");
    const input = {
      path: args.path,
      cwd: exec.cwd,
      sessionId: exec.sessionId,
      viewRange: args.view_range == null ? null : args.view_range,
      fileText: args.file_text == null ? null : args.file_text,
      oldStr: args.old_str == null ? null : args.old_str,
      newStr: args.new_str == null ? null : args.new_str,
      insertLine: args.insert_line == null ? null : args.insert_line,
    };
    if (command === "view") return runView(input);
    if (command === "create") return runCreate(input);
    if (command === "str_replace") return runStrReplace(input);
    return runInsert(input);
  },
};
