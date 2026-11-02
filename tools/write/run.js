"use strict";

// Model-facing write: create or fully replace a UTF-8 text file.
// The fs-observation policy requires reading an existing file first; that check
// lives in core/tools/fs-observe.js and is shared with edit.

const fs = require("fs");
const path = require("path");
const { record, assertVersion } = require("../../core/tools/fs-observe");

const DIFF_BASIS_MAX_BYTES = 200 * 1024;

function parseWriteArgs(args, cwd) {
  const filePath = typeof args.file_path === "string" ? args.file_path : "";
  if (!filePath.trim()) throw new Error("file_path must be a non-empty string");
  if (typeof args.content !== "string") throw new Error("content must be a string");
  const displayPath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
  return { displayPath, content: args.content };
}

function writeError(displayPath, error) {
  const message = error && error.message ? error.message : String(error);
  return new Error('cannot write "' + displayPath + '": ' + message);
}

async function statFile(displayPath) {
  try {
    return await fs.promises.stat(displayPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw writeError(displayPath, error);
  }
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
    throw writeError(displayPath, error);
  }
}

module.exports = {
  async run(args = {}, exec = {}) {
    const input = parseWriteArgs(args, exec.cwd);
    const before = await statFile(input.displayPath);

    if (before && !before.isFile()) {
      throw new Error('cannot write "' + input.displayPath + '": not a regular file');
    }
    // DSH semantics: unseen existing files must be read first; seen files are
    // replaced only at the observed version.
    assertVersion(exec.sessionId, input.displayPath, before, input.displayPath, "write");

    let beforeText = null;
    if (before && before.size <= DIFF_BASIS_MAX_BYTES) {
      try { beforeText = await fs.promises.readFile(input.displayPath, "utf8"); } catch (_) {}
    }

    try {
      await fs.promises.mkdir(path.dirname(input.displayPath), { recursive: true });
    } catch (error) {
      throw writeError(input.displayPath, error);
    }

    await atomicWrite(input.displayPath, input.content, before ? before.mode & 0o777 : 0o666);
    const after = await statFile(input.displayPath);
    record(exec.sessionId, input.displayPath, after);

    return {
      text:
        "<path>" + input.displayPath + "</path>\n" +
        "<type>file</type>\n" +
        "<content>\n" +
        (before ? "Updated file" : "Created file") +
        "\n</content>",
      meta: {
        path: input.displayPath,
        operation: before ? "update" : "create",
        ...(beforeText !== null ? { before: beforeText } : {}),
        ...(Buffer.byteLength(input.content, "utf8") <= DIFF_BASIS_MAX_BYTES ? { after: input.content } : {}),
      },
    };
  },
};
