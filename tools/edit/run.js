"use strict";

// Model-facing literal edit: unique-match by default, replace-all on request.
// Requires a prior read of the same file in this session (fs-observation).

const fs = require("fs");
const path = require("path");
const { record, assertVersion } = require("../../core/tools/fs-observe");

function parseEditArgs(args, cwd) {
  const filePath = typeof args.file_path === "string" ? args.file_path : "";
  if (!filePath.trim()) throw new Error("file_path must be a non-empty string");
  if (typeof args.old_string !== "string" || args.old_string.length === 0) {
    throw new Error("old_string must be a non-empty string");
  }
  if (typeof args.new_string !== "string") throw new Error("new_string must be a string");
  if (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");
  const displayPath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
  return {
    displayPath,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all === true,
  };
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

async function writeFile(displayPath, content, mode) {
  const temp = path.join(
    path.dirname(displayPath),
    "." + path.basename(displayPath) + "." + process.pid + "." + Date.now() + ".tmp"
  );
  try {
    await fs.promises.writeFile(temp, content, { encoding: "utf8", mode: mode || 0o666 });
    if (mode) {
      try { await fs.promises.chmod(temp, mode); } catch (_) {}
    }
    await fs.promises.rename(temp, displayPath);
  } catch (error) {
    try { await fs.promises.unlink(temp); } catch (_) {}
    throw new Error('cannot edit "' + displayPath + '": ' + (error.message || String(error)));
  }
}

module.exports = {
  async run(args = {}, exec = {}) {
    const input = parseEditArgs(args, exec.cwd);

    let info;
    try {
      info = await fs.promises.stat(input.displayPath);
    } catch (error) {
      if (error && error.code === "ENOENT") throw new Error('cannot edit "' + input.displayPath + '": not found');
      throw new Error('cannot edit "' + input.displayPath + '": ' + (error.message || String(error)));
    }
    if (!info.isFile()) throw new Error('cannot edit "' + input.displayPath + '": not a regular file');

    assertVersion(exec.sessionId, input.displayPath, info, input.displayPath, "edit");

    let original;
    try {
      original = normalizeNewlines(await fs.promises.readFile(input.displayPath, "utf8"));
    } catch (error) {
      throw new Error('cannot edit "' + input.displayPath + '": ' + (error.message || String(error)));
    }
    if (original.indexOf("\u0000") !== -1) {
      throw new Error('cannot edit "' + input.displayPath + '": binary file');
    }

    const oldString = normalizeNewlines(input.oldString);
    const newString = normalizeNewlines(input.newString);
    const count = original.split(oldString).length - 1;
    if (count === 0) {
      throw new Error('old_string was not found in "' + input.displayPath + '"');
    }
    if (count > 1 && !input.replaceAll) {
      throw new Error(
        'old_string matched ' + count + ' times in "' + input.displayPath +
        '"; provide a more specific old_string or set replace_all to true'
      );
    }

    let updated;
    if (input.replaceAll) {
      updated = original.split(oldString).join(newString);
    } else {
      const index = original.indexOf(oldString);
      updated = original.slice(0, index) + newString + original.slice(index + oldString.length);
    }

    await writeFile(input.displayPath, updated, info.mode & 0o777);
    const after = await fs.promises.stat(input.displayPath);
    record(exec.sessionId, input.displayPath, after);

    const text = input.replaceAll
      ? "The file " + input.displayPath + " has been updated. All occurrences were successfully replaced."
      : "The file " + input.displayPath + " has been updated successfully.";
    const meta = { path: input.displayPath };
    if (Buffer.byteLength(original, "utf8") <= 200 * 1024) {
      meta.before = original;
      meta.after = updated;
    }
    return { text, meta };
  },
};
