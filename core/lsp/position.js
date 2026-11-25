"use strict";

// Position conversion at the tool/LSP boundary. The model speaks 1-based UTF-16
// line/character coordinates; every LSP request uses 0-based positions. JS
// string indices are also UTF-16 code units, so no code-point or UTF-8 byte
// arithmetic is involved here.

import { LspError } from "./errors.js";

function splitLines(text) {
  return String(text || "").split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

// One-based cursor → zero-based LSP position. `character` may be one past the
// last UTF-16 unit so a cursor at end-of-line is still valid.
function toLspPosition(text, line, character) {
  if (!Number.isInteger(line) || line < 1) {
    throw new LspError("LSP_INVALID_POSITION", "line must be a positive integer");
  }
  if (!Number.isInteger(character) || character < 1) {
    throw new LspError("LSP_INVALID_POSITION", "character must be a positive integer");
  }
  const lines = splitLines(text);
  if (line > lines.length) {
    throw new LspError("LSP_INVALID_POSITION", `line ${line} is past the end of the file (${lines.length} lines)`);
  }
  const lineText = lines[line - 1] || "";
  const maxCharacter = lineText.length + 1;
  if (character > maxCharacter) {
    throw new LspError(
      "LSP_INVALID_POSITION",
      `character ${character} is past the end of line ${line} (${lineText.length} UTF-16 units)`,
    );
  }
  return { line: line - 1, character: character - 1 };
}

function fromLspPosition(position) {
  const line = Number(position && position.line);
  const character = Number(position && position.character);
  return {
    line: Number.isFinite(line) ? line + 1 : 1,
    character: Number.isFinite(character) ? character + 1 : 1,
  };
}

function lineTextAt(text, line) {
  return splitLines(text)[line - 1] || "";
}

const __exports = { splitLines, toLspPosition, fromLspPosition, lineTextAt };
export { splitLines, toLspPosition, fromLspPosition, lineTextAt };
export default __exports;
