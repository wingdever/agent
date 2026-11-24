"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentText } from "../../../accounts/outbound/segment.js";

const bytes = (s) => Buffer.byteLength(s, "utf8");

test("text within the cap stays one piece", () => {
  assert.deepEqual(segmentText("hello 世界", 100), ["hello 世界"]);
  assert.deepEqual(segmentText("", 100), [""]);
});

test("every piece fits the cap and no line is lost", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i} 中文内容`);
  const text = lines.join("\n");
  const pieces = segmentText(text, 120);

  assert.ok(pieces.length > 1, "expected several pieces");
  for (const piece of pieces) assert.ok(bytes(piece) <= 120, `piece is ${bytes(piece)} bytes`);

  const recombined = pieces.join("\n");
  assert.equal(recombined.split("\n").filter((l) => l.startsWith("line ")).length, lines.length);
});

test("fenced code blocks are closed and reopened at piece boundaries", () => {
  const code = Array.from({ length: 40 }, (_, i) => `  console.log(${i});`);
  const text = ["intro", "```js", ...code, "```", "outro"].join("\n");
  const pieces = segmentText(text, 200);

  assert.ok(pieces.length > 1, "expected the code block to span pieces");
  for (const piece of pieces) {
    const markers = piece.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
    assert.equal(markers % 2, 0, `unbalanced fence in piece: ${JSON.stringify(piece.slice(0, 40))}`);
  }
  // Any piece that begins inside the block must reopen it explicitly.
  for (const piece of pieces.slice(1).filter((p) => p.includes("console.log"))) {
    assert.ok(piece.trimStart().startsWith("```"), "piece reopens the fence");
  }
  assert.ok(pieces[0].includes("intro"));
  assert.ok(pieces[pieces.length - 1].includes("outro"));
});

test("a single oversized line is hard split, never dropped", () => {
  const original = "z".repeat(500);
  const pieces = segmentText(original, 100);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(bytes(piece) <= 100);
  assert.equal(pieces.join(""), original);
});

test("an unusable cap is refused", () => {
  assert.throws(() => segmentText("x", 0), /positive finite/);
  assert.throws(() => segmentText("x", Infinity), /positive finite/);
});
