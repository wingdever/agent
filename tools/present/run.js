"use strict";

// present: declare existing files as final deliverables. This tool does not
// copy, move or read file contents; it validates that each path is a regular
// file and returns a durable meta projection the host can use to render file
// cards. Relative paths follow the same rule as the other filesystem tools:
// resolve against the session workspace, not the process working directory.

import path from "node:path";
import { resolveFilePath, statFile } from "./../lib/fs-edit.js";

const MAX_FILES = 4;

function relativeDisplay(absPath, cwd) {
  const relative = path.relative(cwd || process.cwd(), absPath);
  if (!relative) return path.basename(absPath);
  // Keep deliverables outside the workspace explicit instead of emitting a
  // path that starts with "..", which is easy to misread in a tool result.
  if (relative === ".." || relative.startsWith(".." + path.sep)) return absPath;
  return relative;
}

function normalizeFiles(value, cwd) {
  if (!Array.isArray(value)) throw new Error("files must be an array");
  if (value.length === 0) throw new Error("files must contain at least one file");
  if (value.length > MAX_FILES) {
    throw new Error("files may contain at most " + MAX_FILES + " files per call");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("files[" + index + "] must be an object");
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      throw new Error("files[" + index + "].description must be a string");
    }
    const displayPath = resolveFilePath(entry.path, cwd, "files[" + index + "].path");
    return {
      path: displayPath,
      display: relativeDisplay(displayPath, cwd),
      name: path.basename(displayPath),
      description: entry.description || "",
    };
  });
}

function formatPresented(files) {
  const lines = files.map((file) => {
    return "- " + file.display + (file.description ? " — " + file.description : "");
  });
  return (
    "Presented " + files.length + " file" + (files.length === 1 ? "" : "s") + " to the user:\n" +
    lines.join("\n") +
    "\nThe files stay at their current paths; contents are not copied."
  );
}

export default {
  async run(args = {}, exec = {}) {
    const entries = normalizeFiles(args.files, exec.cwd);
    const files = [];

    for (const entry of entries) {
      const info = await statFile(entry.path, "present");
      if (!info.isFile()) {
        throw new Error('cannot present "' + entry.path + '": not a regular file');
      }
      files.push({
        path: entry.path,
        display: entry.display,
        name: entry.name,
        description: entry.description,
        bytes: info.size,
        mtimeMs: info.mtimeMs,
      });
    }

    return {
      text: formatPresented(files),
      meta: {
        files: files.map((file) => ({
          path: file.path,
          display: file.display,
          name: file.name,
          description: file.description,
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
        })),
      },
    };
  },
};

export { MAX_FILES, normalizeFiles, formatPresented, relativeDisplay };
