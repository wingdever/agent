"use strict";

// Model-facing glob: ripgrep --files, hidden and ignored included, VCS metadata
// excluded, modification-time order, first 100 paths plus a spill locator.

const path = require("path");
const { runRg } = require("../lib/ripgrep");
const { writeSpill } = require("../../core/tools/result");

const MAX_RESULTS = 100;
const TIMEOUT_MS = 30000;
const VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

function parseGlobArgs(args) {
  if (typeof args.pattern !== "string" || args.pattern.trim().length === 0) {
    throw new Error("pattern must be a non-empty string");
  }
  if (args.path !== undefined && (typeof args.path !== "string" || args.path.trim().length === 0)) {
    throw new Error("path must be a non-empty string when given");
  }
  return { pattern: args.pattern, path: args.path };
}

function normalizePath(value, cwd) {
  let result = String(value);
  if (path.isAbsolute(result)) {
    const relative = path.relative(cwd, result);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
    return result;
  }
  while (result.startsWith("./")) result = result.slice(2);
  return result;
}

function formatGlob(paths, total, spillPath) {
  if (paths.length === 0) return "No files found";
  const body = paths.join("\n");
  if (total <= MAX_RESULTS) return body;
  const recovery = spillPath
    ? "Full sorted result stored at: " + spillPath + ". Use read with offset/limit, or grep this path to search within it."
    : "The complete result could not be saved; narrow pattern or path to see more.";
  return body + "\n\n(Showing " + paths.length + " of " + total + " paths. " + recovery + ")";
}

module.exports = {
  async run(args = {}, exec = {}) {
    const input = parseGlobArgs(args);
    const cwd = exec.cwd || process.cwd();
    const rgArgs = [
      "--files",
      "--glob=" + input.pattern,
      "--sort=modified",
      "--no-ignore",
      "--hidden",
    ];
    for (const name of VCS_EXCLUDES) {
      rgArgs.push("--glob=!**/" + name, "--glob=!**/" + name + "/**");
    }
    if (input.path !== undefined) rgArgs.push("--", input.path);

    const result = await runRg(rgArgs, { cwd, timeoutMs: TIMEOUT_MS });
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || "ripgrep failed with exit code " + result.code);
    }

    const all = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => normalizePath(line, cwd));
    const shown = all.slice(0, MAX_RESULTS);
    const spillPath = all.length > MAX_RESULTS
      ? writeSpill(exec.callId || "glob", "glob-results", all.join("\n"))
      : null;

    return {
      text: formatGlob(shown, all.length, spillPath),
      meta: {
        root: input.path === undefined ? "." : input.path,
        paths: shown,
        total: all.length,
      },
    };
  },
};
