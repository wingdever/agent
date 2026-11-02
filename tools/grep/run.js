"use strict";

// Model-facing grep: rg --json, first 250 matches, per-line preview bounded to
// 2000 bytes, grouped by file, with a spill locator when capped.

const { runRg } = require("../lib/ripgrep");
const { writeSpill, headByBytes, byteLength } = require("../../core/tools/result");

const MAX_MATCHES = 250;
const MAX_LINE_BYTES = 2000;
const TIMEOUT_MS = 30000;

function validateInclude(include) {
  if (typeof include !== "string" || include.trim().length === 0) {
    throw new Error("include must be a non-empty glob when given");
  }
  if (include.startsWith("!")) {
    throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported');
  }
  let depth = 0;
  for (const char of include) {
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      throw new Error("include must be one glob, not a comma-separated list (use {a,b} alternation instead)");
    }
  }
}

function parseGrepArgs(args) {
  if (typeof args.pattern !== "string" || args.pattern.length === 0) {
    throw new Error("pattern must be a non-empty string");
  }
  if (args.path !== undefined && (typeof args.path !== "string" || args.path.trim().length === 0)) {
    throw new Error("path must be a non-empty string when given");
  }
  if (args.include !== undefined) validateInclude(args.include);
  return { pattern: args.pattern, path: args.path, include: args.include };
}

function previewLine(line) {
  const kept = headByBytes(line, MAX_LINE_BYTES);
  return byteLength(line) > MAX_LINE_BYTES ? kept + " (line truncated)" : kept;
}

function formatMatches(matches) {
  const byFile = new Map();
  for (const match of matches) {
    let group = byFile.get(match.path);
    if (!group) {
      group = [];
      byFile.set(match.path, group);
    }
    group.push(match);
  }
  const sections = [];
  for (const [file, group] of byFile) {
    sections.push(file + "\n" + group.map((m) => "Line " + m.lineNumber + ": " + m.line).join("\n"));
  }
  return sections.join("\n\n");
}

module.exports = {
  async run(args = {}, exec = {}) {
    const input = parseGrepArgs(args);
    const rgArgs = ["--json", "--regexp=" + input.pattern];
    if (input.include !== undefined) rgArgs.push("--glob=" + input.include);
    if (input.path !== undefined) rgArgs.push("--", input.path);

    const result = await runRg(rgArgs, { cwd: exec.cwd || process.cwd(), timeoutMs: TIMEOUT_MS });
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || "ripgrep failed with exit code " + result.code);
    }

    const all = [];
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch (_) { continue; }
      if (!record || record.type !== "match" || !record.data) continue;
      const data = record.data;
      const file = data.path && data.path.text ? data.path.text : "";
      const lineNumber = data.line_number;
      const text = data.lines && typeof data.lines.text === "string" ? data.lines.text : "";
      if (!file || typeof lineNumber !== "number") continue;
      all.push({
        path: file,
        lineNumber,
        line: previewLine(text.replace(/\r?\n$/, "")),
      });
    }

    if (all.length === 0) {
      return { text: "No matches found", meta: { matches: [], total: 0 } };
    }

    const retained = all.slice(0, MAX_MATCHES);
    const header = all.length > MAX_MATCHES
      ? "Found " + MAX_MATCHES + " of " + all.length + " matches"
      : "Found " + all.length + (all.length === 1 ? " match" : " matches");
    let text = header + "\n\n" + formatMatches(retained);

    if (all.length > MAX_MATCHES) {
      const spillPath = writeSpill(exec.callId || "grep", "grep-results", header.replace(/ of .*$/, " of " + all.length + " matches") + "\n\n" + formatMatches(all));
      text += "\n\n(" + (spillPath
        ? "Full grep result stored at: " + spillPath + ". Use read with offset/limit, or grep this path to search within it."
        : "The complete result could not be saved; narrow pattern, path, or include to see more.") + ")";
    }

    return {
      text,
      meta: {
        pattern: input.pattern,
        path: input.path,
        matches: retained.map((m) => ({
          path: m.path,
          lineNumber: m.lineNumber,
          line: headByBytes(m.line, 200),
        })),
        total: all.length,
      },
    };
  },
};
