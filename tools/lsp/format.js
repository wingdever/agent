"use strict";

// Model-facing formatting for LSP results. The service returns stable
// structures; this file is the only place that decides how a location or a
// hover block should look to the model.

import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LOCATIONS = 50;
const MAX_HOVER_CHARS = 16000;

function oneBasedPosition(position) {
  const line = Number(position && position.line);
  const character = Number(position && position.character);
  return {
    line: Number.isFinite(line) ? line + 1 : 1,
    character: Number.isFinite(character) ? character + 1 : 1,
  };
}

function uriToPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch (_) {
    return null;
  }
}

function workspacePath(filePath, cwd) {
  const base = cwd || process.cwd();
  const rel = path.relative(base, filePath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return filePath + " (outside workspace)";
}

function displayInputPath(filePath, cwd) {
  const base = cwd || process.cwd();
  const abs = path.resolve(base, filePath);
  return workspacePath(abs, base);
}

function dedupeLocations(locations) {
  const seen = new Set();
  const out = [];
  for (const location of locations || []) {
    if (!location || typeof location.uri !== "string" || !location.range || !location.range.start) continue;
    const line = Number(location.range.start.line);
    const character = Number(location.range.start.character);
    if (!Number.isFinite(line) || !Number.isFinite(character)) continue;
    const key = `${location.uri}\0${line}\0${character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ location, line, character });
  }
  return out;
}

function formatLocations(result, { operation, filePath, line, character, cwd }) {
  const entries = dedupeLocations(result.locations);
  const label = operation === "findReferences"
    ? "References"
    : operation === "goToImplementation"
      ? "Implementations"
      : "Definitions";
  if (!entries.length) return `No ${label.toLowerCase()} found at ${displayInputPath(filePath, cwd)}:${line}:${character}.`;
  entries.sort((a, b) => {
    const ap = uriToPath(a.location.uri) || a.location.uri;
    const bp = uriToPath(b.location.uri) || b.location.uri;
    return ap.localeCompare(bp) || a.line - b.line || a.character - b.character;
  });
  const suffix = operation === "findReferences" ? ", including declaration" : "";
  const header = entries.length > MAX_LOCATIONS
    ? `${label} (${entries.length}${suffix}; showing first ${MAX_LOCATIONS}):`
    : `${label} (${entries.length}${suffix}):`;
  const lines = [header];
  for (const entry of entries.slice(0, MAX_LOCATIONS)) {
    const target = uriToPath(entry.location.uri);
    const where = target
      ? workspacePath(target, cwd)
      : `${entry.location.uri} [non-file URI]`;
    const position = oneBasedPosition({ line: entry.line, character: entry.character });
    lines.push(`- ${where}:${position.line}:${position.character}`);
  }
  if (entries.length > MAX_LOCATIONS) {
    lines.push(`... ${entries.length - MAX_LOCATIONS} more not shown`);
  }
  return lines.join("\n");
}

function formatHover(result, { filePath, line, character, cwd }) {
  const hover = result.hover || {};
  const text = String(hover.text || "").trim();
  if (!text) return `No hover information at ${displayInputPath(filePath, cwd)}:${line}:${character}.`;
  const clipped = text.length > MAX_HOVER_CHARS
    ? text.slice(0, MAX_HOVER_CHARS) + "\n... [hover truncated]"
    : text;
  return `Hover at ${displayInputPath(filePath, cwd)}:${line}:${character}:\n${clipped}`;
}

function formatLspResult(result, { operation, filePath, line, character, cwd }) {
  if (operation === "hover") return formatHover(result, { filePath, line, character, cwd });
  return formatLocations(result, { operation, filePath, line, character, cwd });
}

const __exports = { formatLspResult, formatLocations, formatHover };
export { formatLspResult, formatLocations, formatHover };
export default __exports;
