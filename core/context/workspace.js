"use strict";

// Workspace folder resolution. Moved out of core/index.js so both the turn
// runtime and the context service can use it without importing the composition
// root.

import fs from "fs";
import os from "os";
import path from "path";

function isDirectory(folder) {
  try {
    return fs.statSync(folder).isDirectory();
  } catch (_) {
    return false;
  }
}

function workspaceFolderCandidates(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return [];
  if (path.isAbsolute(text)) return [path.resolve(text)];
  const candidates = [path.resolve(process.cwd(), text)];
  if (path.basename(process.cwd()) === text) candidates.push(process.cwd());
  candidates.push(path.resolve(os.homedir(), text));
  candidates.push(path.resolve(process.cwd(), "..", text));
  return [...new Set(candidates)];
}

function resolveWorkspaceFolder(raw) {
  for (const candidate of workspaceFolderCandidates(raw)) {
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

const __exports = { isDirectory, workspaceFolderCandidates, resolveWorkspaceFolder };
export { isDirectory, workspaceFolderCandidates, resolveWorkspaceFolder };
export default __exports;
