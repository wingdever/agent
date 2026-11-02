"use strict";

// Model-facing UTF-8 text read, following dsh semantics:
// - line-numbered output inside a <path>/<type>/<content> envelope
// - offset/limit window (1-based, limit defaults to and cannot exceed 2000)
// - per-line cap (2000 chars), per-call byte cap (50KB), exact total line count
// - files at or above 10MB stream instead of loading whole into memory
// - CRLF is stripped, offset past EOF is an error, NUL bytes mean binary
//
// `exec.cwd` (the conversation workspace) resolves relative paths; absolute
// paths are honored as-is.

const fs = require("fs");
const path = require("path");

const READ_LIMIT = 2000;
const READ_MAX_LINE_LENGTH = 2000;
const READ_MAX_BYTES = 50 * 1024;
const STREAM_MIN_SIZE = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

function parsePositiveInteger(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(name + " must be a positive integer");
  }
  return value;
}

function parseReadArgs(args, cwd) {
  const filePath = typeof args.file_path === "string" ? args.file_path : "";
  if (!filePath.trim()) throw new Error("file_path must be a non-empty string");
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, "offset");
  const limit = args.limit === undefined ? READ_LIMIT : parsePositiveInteger(args.limit, "limit");
  if (limit > READ_LIMIT) throw new Error("limit must be less than or equal to " + READ_LIMIT);
  const displayPath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
  return { displayPath, offset, limit };
}

function readError(displayPath, error) {
  const code = error && error.code;
  if (code === "ENOENT") return new Error('cannot read "' + displayPath + '": not found');
  if (code === "EACCES" || code === "EPERM") return new Error('cannot read "' + displayPath + '": permission denied');
  if (code === "EISDIR") return new Error('cannot read "' + displayPath + '": not a regular file');
  return new Error('cannot read "' + displayPath + '": ' + (error && error.message ? error.message : String(error)));
}

async function statRegularFile(displayPath) {
  let info;
  try {
    info = await fs.promises.stat(displayPath);
  } catch (e) {
    throw readError(displayPath, e);
  }
  if (!info.isFile()) throw new Error('cannot read "' + displayPath + '": not a regular file');
  return info;
}

function assertNotBinary(sample, displayPath) {
  const hasNul = typeof sample === "string"
    ? sample.slice(0, BINARY_SNIFF_BYTES).indexOf("\u0000") !== -1
    : sample.subarray(0, BINARY_SNIFF_BYTES).indexOf(0) !== -1;
  if (hasNul) throw new Error('cannot read "' + displayPath + '": binary file (NUL byte)');
}

// Yield decoded text chunks in file order. Small files are read whole; large
// files stream so a size-less giant file never buffers entirely.
async function* readChunks(displayPath, size) {
  if (size < STREAM_MIN_SIZE) {
    let buffer;
    try {
      buffer = await fs.promises.readFile(displayPath);
    } catch (e) {
      throw readError(displayPath, e);
    }
    assertNotBinary(buffer, displayPath);
    yield buffer.toString("utf8");
    return;
  }

  const stream = fs.createReadStream(displayPath, { encoding: "utf8" });
  let first = true;
  try {
    for await (const chunk of stream) {
      if (first) {
        assertNotBinary(chunk, displayPath);
        first = false;
      }
      yield chunk;
    }
  } catch (e) {
    if (e && e.code) throw readError(displayPath, e);
    throw e;
  }
}

// Scan every chunk for the exact total line count while only materializing the
// requested window and enforcing the per-line and per-call byte caps.
async function buildWindow(chunks, request, displayPath) {
  const lines = [];
  let totalLines = 0;
  let outputBytes = 0;
  let truncatedByBytes = false;

  function consumeLine(rawLine) {
    totalLines += 1;
    if (truncatedByBytes || totalLines < request.offset || lines.length >= request.limit) return;
    const text = rawLine.length > request.maxLineLength
      ? rawLine.slice(0, request.maxLineLength) + "... (line truncated to " + request.maxLineLength + " chars)"
      : rawLine;
    const bytes = Buffer.byteLength(text, "utf8") + (lines.length > 0 ? 1 : 0);
    if (outputBytes + bytes > request.maxBytes) {
      truncatedByBytes = true;
      return;
    }
    outputBytes += bytes;
    lines.push({ number: totalLines, text });
  }

  const lineBufferCap = request.maxLineLength + 1;
  let lineBuffer = "";
  function appendToLineBuffer(segment) {
    if (lineBuffer.length >= lineBufferCap) return;
    lineBuffer += segment;
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
  }
  function flushLine() {
    consumeLine(lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer);
    lineBuffer = "";
  }

  for await (const chunk of chunks) {
    let start = 0;
    let newline;
    while ((newline = chunk.indexOf("\n", start)) !== -1) {
      appendToLineBuffer(chunk.slice(start, newline));
      flushLine();
      start = newline + 1;
    }
    appendToLineBuffer(chunk.slice(start));
  }
  if (lineBuffer.length > 0) flushLine();

  if (!truncatedByBytes && request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new Error('offset ' + request.offset + ' is out of range for "' + displayPath + '" (' + totalLines + " lines)");
  }
  return { lines, totalLines, truncatedByBytes };
}

function formatReadOutput(displayPath, outcome) {
  const endLine = outcome.lines.length > 0
    ? outcome.lines[outcome.lines.length - 1].number
    : Math.max(0, outcome.offset - 1);
  let footer;
  if (outcome.truncatedByBytes) {
    footer = "(Output capped. Showing lines " + outcome.offset + "-" + endLine + ". Use offset=" + (endLine + 1) + " to continue.)";
  } else if (endLine < outcome.totalLines) {
    footer = "(Showing lines " + outcome.offset + "-" + endLine + " of " + outcome.totalLines + ". Use offset=" + (endLine + 1) + " to continue.)";
  } else {
    footer = "(End of file - total " + outcome.totalLines + " lines)";
  }
  const body = outcome.lines.length > 0
    ? outcome.lines.map((line) => line.number + ": " + line.text).join("\n") + "\n\n" + footer
    : footer;
  return "<path>" + displayPath + "</path>\n<type>file</type>\n<content>\n" + body + "\n</content>";
}

module.exports = {
  READ_LIMIT,
  async run(args = {}, exec = {}) {
    const input = parseReadArgs(args, exec.cwd);
    const info = await statRegularFile(input.displayPath);
    const window = await buildWindow(
      readChunks(input.displayPath, info.size),
      {
        offset: input.offset,
        limit: input.limit,
        maxLineLength: READ_MAX_LINE_LENGTH,
        maxBytes: READ_MAX_BYTES,
      },
      input.displayPath
    );
    return formatReadOutput(input.displayPath, {
      offset: input.offset,
      lines: window.lines,
      totalLines: window.totalLines,
      truncatedByBytes: window.truncatedByBytes,
    });
  },
};
