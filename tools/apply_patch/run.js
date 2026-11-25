"use strict";

// apply_patch: one patch for cross-file or separated edits.
//
// The whole patch is parsed and validated against the current tree before any
// write starts. Once validation passes, actions run in order and stop at the
// first failure; there is intentionally no rollback (same contract as DSH).

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
} from "./../lib/fs-edit.js";
import { record } from "./../../lib/fs-observe/index.js";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

function isDirective(line) {
  return line === END || line.startsWith("*** Add File:") || line.startsWith("*** Update File:") ||
    line.startsWith("*** Delete File:") || line.startsWith("*** Move to:") || line.startsWith("*** End of File");
}

function parsePatch(input, cwd) {
  if (typeof input !== "string" || !input.trim()) throw new Error("input must be a non-empty patch string");
  if (Buffer.byteLength(input, "utf8") > MAX_PATCH_BYTES) {
    throw new Error("patch is larger than " + MAX_PATCH_BYTES + " bytes");
  }
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (lines[i] !== BEGIN) throw new Error("patch must start with " + BEGIN);
  i += 1;

  const operations = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line === END) {
      i += 1;
      while (i < lines.length && lines[i].trim() === "") i += 1;
      if (i < lines.length) throw new Error("unexpected content after " + END);
      return operations;
    }
    if (line.trim() === "") { i += 1; continue; }

    if (line.startsWith("*** Add File:")) {
      const target = resolveFilePath(line.slice("*** Add File:".length).trim(), cwd, "patch path");
      i += 1;
      const content = [];
      while (i < lines.length && !isDirective(lines[i])) {
        const body = lines[i];
        if (body.startsWith("+")) {
          content.push(body.slice(1));
        } else if (body === "") {
          content.push("");
        } else {
          throw new Error("add file lines must start with + (line: " + JSON.stringify(body) + ")");
        }
        i += 1;
      }
      operations.push({ kind: "add", path: target, lines: content });
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const target = resolveFilePath(line.slice("*** Delete File:".length).trim(), cwd, "patch path");
      i += 1;
      while (i < lines.length && lines[i].trim() === "") i += 1;
      if (i < lines.length && !isDirective(lines[i])) {
        throw new Error("delete file cannot contain hunk lines (line: " + JSON.stringify(lines[i]) + ")");
      }
      operations.push({ kind: "delete", path: target });
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const target = resolveFilePath(line.slice("*** Update File:".length).trim(), cwd, "patch path");
      i += 1;
      let moveTo = null;
      if (i < lines.length && lines[i].startsWith("*** Move to:")) {
        moveTo = resolveFilePath(lines[i].slice("*** Move to:".length).trim(), cwd, "move path");
        i += 1;
      }
      const hunks = [];
      let current = null;
      while (i < lines.length) {
        const body = lines[i];
        if (body === END || body.startsWith("*** Add File:") || body.startsWith("*** Update File:") ||
          body.startsWith("*** Delete File:")) {
          break;
        }
        if (body.startsWith("*** Move to:")) {
          throw new Error("*** Move to must immediately follow *** Update File: <path>");
        }
        if (body.startsWith("*** End of File")) {
          if (!current) throw new Error("*** End of File must follow a hunk");
          current.endOfFile = true;
          i += 1;
          continue;
        }
        if (body.startsWith("@@")) {
          current = { anchor: body.slice(2).trim(), ops: [], endOfFile: false };
          hunks.push(current);
          i += 1;
          continue;
        }
        if (body.startsWith("+") || body.startsWith("-") || body.startsWith(" ")) {
          if (!current) {
            current = { anchor: "", ops: [], endOfFile: false };
            hunks.push(current);
          }
          current.ops.push({ kind: body[0], text: body.slice(1) });
          i += 1;
          continue;
        }
        if (body === "") {
          if (current) current.ops.push({ kind: " ", text: "" });
          else i += 1;
          continue;
        }
        throw new Error("unexpected patch line: " + JSON.stringify(body));
      }
      if (hunks.length === 0 && !moveTo) throw new Error("update file has no hunks");
      operations.push({ kind: "update", path: target, moveTo, hunks });
      continue;
    }

    throw new Error("unknown patch directive: " + JSON.stringify(line));
  }

  throw new Error("patch is missing " + END);
}

function linesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function findMatches(haystack, needle) {
  const matches = [];
  if (needle.length === 0) return matches;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (linesEqual(haystack.slice(i, i + needle.length), needle)) matches.push(i);
  }
  return matches;
}

function applyHunks(lines, hunks, displayPath) {
  let current = lines.slice();
  for (const hunk of hunks) {
    const oldLines = [];
    const newLines = [];
    for (const entry of hunk.ops) {
      if (entry.kind === " ") {
        oldLines.push(entry.text);
        newLines.push(entry.text);
      } else if (entry.kind === "-") {
        oldLines.push(entry.text);
      } else if (entry.kind === "+") {
        newLines.push(entry.text);
      }
    }
    if (oldLines.length === 0 && newLines.length === 0) {
      throw new Error('empty hunk in "' + displayPath + '"');
    }

    let index;
    if (oldLines.length === 0) {
      if (!hunk.anchor) throw new Error('hunk in "' + displayPath + '" has no context or @@ anchor');
      const matches = [];
      for (let i = 0; i < current.length; i += 1) {
        if (current[i].includes(hunk.anchor)) matches.push(i);
      }
      if (matches.length === 0) throw new Error('@@ anchor not found in "' + displayPath + '": ' + hunk.anchor);
      if (matches.length > 1) {
        throw new Error('@@ anchor is ambiguous in "' + displayPath + '": ' + hunk.anchor + " (matched " + matches.length + " lines)");
      }
      index = matches[0] + 1;
    } else {
      const matches = findMatches(current, oldLines);
      if (matches.length === 0) throw new Error('hunk did not match "' + displayPath + '"');
      if (matches.length > 1) {
        throw new Error('hunk is ambiguous in "' + displayPath + '": matched ' + matches.length + " locations; add more context");
      }
      index = matches[0];
      if (hunk.endOfFile && index + oldLines.length !== current.length) {
        throw new Error('*** End of File anchor did not match the end of "' + displayPath + '"');
      }
    }

    current = current.slice(0, index).concat(newLines, current.slice(index + oldLines.length));
  }
  return current;
}

async function loadState(pathname, cache, cwd) {
  if (cache.has(pathname)) return cache.get(pathname);
  try {
    const info = await statFile(pathname, "patch");
    if (!info.isFile()) throw new Error('cannot patch "' + pathname + '": not a regular file');
    if (info.size > 10 * 1024 * 1024) throw new Error('cannot patch "' + pathname + '": file is larger than 10MB');
    const { text } = await readTextFile(pathname, { verb: "patch" });
    const state = { exists: true, text, mode: info.mode & 0o777 };
    cache.set(pathname, state);
    return state;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const state = { exists: false, text: "", mode: 0o666 };
      cache.set(pathname, state);
      return state;
    }
    throw error;
  }
}

function setState(cache, pathname, state) {
  cache.set(pathname, state);
}

async function validateAndPlan(operations, cwd) {
  const cache = new Map();
  const actions = [];

  for (const op of operations) {
    if (op.kind === "add") {
      const state = await loadState(op.path, cache, cwd);
      if (state.exists) throw new Error('cannot add "' + op.path + '": file already exists');
      const text = op.lines.length === 0 ? "" : op.lines.join("\n") + "\n";
      setState(cache, op.path, { exists: true, text, mode: 0o666 });
      actions.push({ kind: "write", path: op.path, before: null, after: text, mode: 0o666 });
      continue;
    }

    if (op.kind === "delete") {
      const state = await loadState(op.path, cache, cwd);
      if (!state.exists) throw new Error('cannot delete "' + op.path + '": not found');
      setState(cache, op.path, { exists: false, text: "", mode: 0o666 });
      actions.push({ kind: "delete", path: op.path, before: state.text });
      continue;
    }

    const state = await loadState(op.path, cache, cwd);
    if (!state.exists) throw new Error('cannot update "' + op.path + '": not found');
    const parts = splitLines(state.text);
    const updatedLines = applyHunks(parts.lines, op.hunks, op.path);
    const updated = joinLines(updatedLines, parts.trailingNewline);

    if (op.moveTo) {
      if (op.moveTo === op.path) throw new Error('cannot move "' + op.path + '" to itself');
      const dest = await loadState(op.moveTo, cache, cwd);
      if (dest.exists) throw new Error('cannot move to "' + op.moveTo + '": destination already exists');
      setState(cache, op.path, { exists: false, text: "", mode: 0o666 });
      setState(cache, op.moveTo, { exists: true, text: updated, mode: state.mode });
      actions.push({ kind: "move", path: op.path, to: op.moveTo, before: state.text, after: updated, mode: state.mode });
    } else {
      setState(cache, op.path, { exists: true, text: updated, mode: state.mode });
      actions.push({ kind: "write", path: op.path, before: state.text, after: updated, mode: state.mode });
    }
  }

  return actions;
}

async function applyActions(actions, sessionId) {
  const files = [];
  for (const action of actions) {
    if (action.kind === "write") {
      await ensureParent(action.path);
      await atomicWrite(action.path, action.after, action.mode);
      const after = await statFile(action.path, "write");
      record(sessionId, action.path, after);
      files.push(fileChangeMeta(action.path, action.before == null ? "add" : "update", action.before, action.after));
      continue;
    }
    if (action.kind === "delete") {
      try {
        await fs.promises.unlink(action.path);
      } catch (error) {
        throw new Error('cannot delete "' + action.path + '": ' + (error.message || String(error)));
      }
      record(sessionId, action.path, null);
      files.push(fileChangeMeta(action.path, "delete", action.before, null));
      continue;
    }
    if (action.kind === "move") {
      await ensureParent(action.to);
      await atomicWrite(action.to, action.after, action.mode);
      try {
        await fs.promises.unlink(action.path);
      } catch (error) {
        throw new Error('cannot remove source "' + action.path + '" after move: ' + (error.message || String(error)));
      }
      const after = await statFile(action.to, "write");
      record(sessionId, action.to, after);
      record(sessionId, action.path, null);
      files.push(fileChangeMeta(action.path, "move", action.before, null, action.to));
      files[files.length - 1].to = action.to;
      files.push(fileChangeMeta(action.to, "add", null, action.after));
    }
  }
  return files;
}

function formatResult(files) {
  const lines = files.map((file) => {
    if (file.operation === "add") return "A " + file.path;
    if (file.operation === "delete") return "D " + file.path;
    if (file.operation === "move") return "M " + file.path + " -> " + (file.to || "");
    return "M " + file.path;
  });
  return "Success. Updated the following files:\n" + lines.join("\n");
}

export default {
  async run(args = {}, exec = {}) {
    const operations = parsePatch(args.input, exec.cwd);
    if (operations.length === 0) throw new Error("patch contains no file operations");
    const actions = await validateAndPlan(operations, exec.cwd);
    const files = await applyActions(actions, exec.sessionId);
    return {
      text: formatResult(files),
      meta: {
        files,
        patch: args.input,
      },
    };
  },
};
