"use strict";

// Shared filesystem primitives for the editing tools. The existing read/write/
// edit tools keep their own historical wording; new tools use these helpers so
// path resolution, atomic writes and meta projections stay consistent.

import fs from "fs";
import path from "path";

const META_TEXT_MAX_BYTES = 200 * 1024;

function resolveFilePath(filePath, cwd, name = "file_path") {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error(name + " must be a non-empty string");
  }
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
}

function describeError(verb, displayPath, error) {
  const code = error && error.code;
  let message;
  if (code === "ENOENT") message = 'cannot ' + verb + ' "' + displayPath + '": not found';
  else if (code === "EACCES" || code === "EPERM") message = 'cannot ' + verb + ' "' + displayPath + '": permission denied';
  else if (code === "EISDIR") message = 'cannot ' + verb + ' "' + displayPath + '": not a regular file';
  else message = 'cannot ' + verb + ' "' + displayPath + '": ' + (error && error.message ? error.message : String(error));
  const wrapped = new Error(message);
  if (code) wrapped.code = code;
  return wrapped;
}

async function statFile(displayPath, verb = "read") {
  try {
    return await fs.promises.stat(displayPath);
  } catch (error) {
    throw describeError(verb, displayPath, error);
  }
}

async function readTextFile(displayPath, { verb = "read", maxBytes = 10 * 1024 * 1024 } = {}) {
  const info = await statFile(displayPath, verb);
  if (!info.isFile()) throw new Error('cannot ' + verb + ' "' + displayPath + '": not a regular file');
  if (info.size > maxBytes) {
    throw new Error('cannot ' + verb + ' "' + displayPath + '": file is larger than ' + maxBytes + " bytes");
  }
  let text;
  try {
    text = await fs.promises.readFile(displayPath, "utf8");
  } catch (error) {
    throw describeError(verb, displayPath, error);
  }
  if (text.indexOf("\u0000") !== -1) throw new Error('cannot ' + verb + ' "' + displayPath + '": binary file');
  return { text, info };
}

async function atomicWrite(displayPath, content, mode) {
  const dir = path.dirname(displayPath);
  const base = path.basename(displayPath);
  const temp = path.join(dir, "." + base + "." + process.pid + "." + Date.now() + ".tmp");
  try {
    await fs.promises.writeFile(temp, content, { encoding: "utf8", mode: mode || 0o666 });
    if (mode) {
      try { await fs.promises.chmod(temp, mode); } catch (_) {}
    }
    await fs.promises.rename(temp, displayPath);
  } catch (error) {
    try { await fs.promises.unlink(temp); } catch (_) {}
    throw describeError("write", displayPath, error);
  }
}

async function ensureParent(displayPath) {
  try {
    await fs.promises.mkdir(path.dirname(displayPath), { recursive: true });
  } catch (error) {
    throw describeError("write", displayPath, error);
  }
}

function splitLines(text) {
  const value = String(text);
  const lines = value.split("\n");
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinLines(lines, trailingNewline) {
  const text = lines.join("\n");
  return trailingNewline ? text + "\n" : text;
}

function textForMeta(text) {
  const value = String(text == null ? "" : text);
  return Buffer.byteLength(value, "utf8") <= META_TEXT_MAX_BYTES ? value : null;
}

function fileChangeMeta(displayPath, operation, before, after) {
  const entry = {
    path: displayPath,
    operation,
  };
  const beforeText = before == null ? null : textForMeta(before);
  const afterText = after == null ? null : textForMeta(after);
  if (beforeText !== null) entry.before = beforeText;
  if (afterText !== null) entry.after = afterText;
  if (before != null && beforeText === null) entry.beforeTruncated = true;
  if (after != null && afterText === null) entry.afterTruncated = true;
  return entry;
}

function lineView(text, start = 1, end = Infinity) {
  const { lines, trailingNewline } = splitLines(text);
  const first = Math.max(1, start);
  const last = Math.min(lines.length, end === -1 ? lines.length : end);
  if (first > lines.length && !(lines.length === 0 && first === 1)) {
    throw new Error("view_range starts past the end of the file (" + lines.length + " lines)");
  }
  const selected = [];
  for (let i = first; i <= last; i += 1) selected.push((i) + ": " + lines[i - 1]);
  return {
    text: selected.join("\n"),
    totalLines: lines.length,
    trailingNewline,
  };
}

export {
  META_TEXT_MAX_BYTES,
  resolveFilePath,
  describeError,
  statFile,
  readTextFile,
  atomicWrite,
  ensureParent,
  splitLines,
  joinLines,
  fileChangeMeta,
  lineView,
};
export default {
  META_TEXT_MAX_BYTES,
  resolveFilePath,
  describeError,
  statFile,
  readTextFile,
  atomicWrite,
  ensureParent,
  splitLines,
  joinLines,
  fileChangeMeta,
  lineView,
};
