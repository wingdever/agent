"use strict";

// Outbound segmentation.
//
// Sending over a platform limit is not a formatting mistake, it is a delivery
// failure: the platform rejects the whole message. So splitting belongs to the
// transport pipeline, not to the driver's presentation code. What the pieces
// look like (one card per piece, or one text per piece) stays the driver's call.
//
// Fenced code blocks are closed at the end of a piece and reopened at the start
// of the next one, so a chunk boundary never leaves an unterminated fence.

function byteLen(text) {
  return Buffer.byteLength(text, "utf8");
}

function splitByBytes(line, budget) {
  const pieces = [];
  let current = "";
  for (const ch of Array.from(line)) {
    if (current && byteLen(current + ch) > budget) {
      pieces.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) pieces.push(current);
  return pieces.length ? pieces : [""];
}

/**
 * @param {string} text
 * @param {number} maxBytes hard cap per returned piece, in UTF-8 bytes
 * @returns {string[]}
 */
export function segmentText(text, maxBytes) {
  const input = String(text == null ? "" : text);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive finite number");
  }
  if (byteLen(input) <= maxBytes) return [input];

  // Leave room for a closing fence plus a reopened header when a piece ends
  // inside a code block.
  const budget = Math.max(8, maxBytes - 32);

  // Each entry is a fragment; `newline` says whether it starts a new source
  // line or continues one that had to be split. A hard split must not inject
  // a newline into the user's text.
  const fragments = [];
  const isFence = (s) => s.trimStart().startsWith("```");
  for (const line of input.split("\n")) {
    if (byteLen(line) > budget) {
      const pieces = splitByBytes(line, budget);
      pieces.forEach((piece, i) => fragments.push({ text: piece, newline: i === 0, fence: false }));
    } else {
      fragments.push({ text: line, newline: true, fence: isFence(line) });
    }
  }

  const chunks = [];
  let buf = "";
  let inFence = false;
  let fenceLang = "";

  const flush = () => {
    if (!buf) return;
    chunks.push(inFence ? buf + "\n```" : buf);
    buf = inFence ? "```" + fenceLang : "";
  };

  for (const fragment of fragments) {
    const sep = buf && fragment.newline ? 1 : 0;
    const closing = inFence ? 4 : 0;
    if (buf && byteLen(buf) + sep + byteLen(fragment.text) + closing > maxBytes) flush();
    buf += (buf && fragment.newline ? "\n" : "") + fragment.text;

    if (fragment.fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fragment.text.trimStart().slice(3).trim();
      } else {
        inFence = false;
        fenceLang = "";
      }
    }
  }
  if (buf) chunks.push(inFence ? buf + "\n```" : buf);
  return chunks;
}
