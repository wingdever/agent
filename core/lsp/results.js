"use strict";

// Normalize the three result shapes LSP servers actually return. Location,
// LocationLink and Hover all get one internal shape; only the tool layer turns
// them into model text.

function asRange(value) {
  if (!value || typeof value !== "object") return null;
  const start = value.start && typeof value.start === "object" ? value.start : null;
  const end = value.end && typeof value.end === "object" ? value.end : null;
  if (!start) return null;
  return {
    start: { line: Number(start.line), character: Number(start.character) },
    end: end ? { line: Number(end.line), character: Number(end.character) } : null,
  };
}

function normalizeLocations(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    // LocationLink uses targetUri/targetSelectionRange; Location uses uri/range.
    const uri = typeof item.targetUri === "string" ? item.targetUri : item.uri;
    const range = asRange(item.targetSelectionRange || item.targetRange || item.range);
    if (typeof uri !== "string" || !uri || !range) continue;
    out.push({ uri, range });
  }
  return out;
}

function markedString(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.value !== "string") return "";
  if (typeof value.language === "string" && value.language) {
    return "```" + value.language + "\n" + value.value + "\n```";
  }
  return value.value;
}

function normalizeHover(raw) {
  if (!raw || typeof raw !== "object") return { text: "", kind: "plaintext", range: null };
  const contents = raw.contents;
  let text = "";
  let kind = "plaintext";
  if (typeof contents === "string") {
    text = contents;
  } else if (Array.isArray(contents)) {
    text = contents.map(markedString).filter(Boolean).join("\n\n");
  } else if (contents && typeof contents === "object") {
    if (typeof contents.value === "string") {
      text = contents.value;
      kind = contents.kind === "markdown" ? "markdown" : "plaintext";
    } else {
      text = markedString(contents);
    }
  }
  return { text: text.trim(), kind, range: asRange(raw.range) };
}

const __exports = { normalizeLocations, normalizeHover };
export { normalizeLocations, normalizeHover };
export default __exports;
