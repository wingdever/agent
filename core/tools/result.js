"use strict";

// Model-facing tool results are text. Tools may also return `meta` for the UI;
// `meta` never enters the model conversation. Errors use the same "Error: ..."
// prefix DSH uses, so a model that learned to read DSH tool output behaves the
// same here.

const fs = require("fs");
const path = require("path");

const SPILL_ROOT = path.join(__dirname, "..", "..", "tmp", "tool-output");

function errorResult(message) {
  return { text: "Error: " + String(message == null ? "" : message), isError: true };
}

function normalizeResult(result) {
  if (typeof result === "string") return { text: result, isError: false };
  if (result && typeof result === "object" && typeof result.text === "string") {
    return {
      text: result.text,
      meta: result.meta,
      isError: result.isError === true,
    };
  }
  if (result === undefined || result === null) return { text: "", isError: false };
  // Legacy tools (calculator/get_current_time) return plain objects. They are
  // not model-visible by default, but keeping the fallback avoids a hard crash
  // if someone opts them in.
  return { text: JSON.stringify(result), isError: false };
}

function safeSegment(value) {
  const text = String(value == null ? "" : value);
  return text.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "call";
}

// Save a complete tool result under tmp/tool-output/<callId>/<name>.txt and
// return the absolute path, or null when it could not be written. Spill is a
// recovery path for truncated output; losing it must not fail the tool call.
function writeSpill(callId, name, text) {
  try {
    const dir = path.join(SPILL_ROOT, safeSegment(callId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeSegment(name) + ".txt");
    fs.writeFileSync(file, String(text), "utf8");
    return file;
  } catch (_) {
    return null;
  }
}

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

// Keep the last `maxBytes` bytes without cutting a UTF-8 code point in half.
function tailByBytes(text, maxBytes) {
  const value = String(text);
  if (byteLength(value) <= maxBytes) return value;
  const buf = Buffer.from(value, "utf8");
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

// Keep the first `maxBytes` bytes without cutting a UTF-8 code point in half.
function headByBytes(text, maxBytes) {
  const value = String(text);
  if (byteLength(value) <= maxBytes) return value;
  const buf = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

module.exports = {
  SPILL_ROOT,
  errorResult,
  normalizeResult,
  writeSpill,
  byteLength,
  tailByBytes,
  headByBytes,
};
