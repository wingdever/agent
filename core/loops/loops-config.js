"use strict";

// user/loops.json: user-managed hook overlay for the node-graph engine.
//
// The file is a FLAT array of hook entries: [ { on, slot, target }, ... ].
// Array order is execution order. Only hooks are stored; node definitions and
// the next chain live in core/loops/nodes/* registry.json (read-only).
//
// This module depends only on fs/path so it never forms a circular dependency
// with the engine, registry or core index.

const fs = require("fs");
const path = require("path");

const LOOPS_FILE = path.join(__dirname, "..", "..", "user", "loops.json");

// Repo default: keep node-graph behavior identical to the former
// settings.translate.enabled gating (translate on by default). Builtin node
// ids are prefixed "builtin." (see core/loops/builtins/*/registry.json).
const DEFAULT_HOOKS = [
  { on: "resolve-input", slot: "before", target: "builtin.translate-input" },
  { on: "model-request", slot: "after", target: "builtin.translate-output" },
];

// Read the overlay. A missing/broken file falls back to the repo default so the
// engine keeps its default translate behavior without migration/compat code.
function readLoops() {
  try {
    const data = JSON.parse(fs.readFileSync(LOOPS_FILE, "utf8"));
    return Array.isArray(data) ? data : DEFAULT_HOOKS.slice();
  } catch (_) {
    return DEFAULT_HOOKS.slice();
  }
}

// Persist the whole hooks array (overall replace, not incremental). No
// validation here: callers validate first (see validateHooks).
function writeLoops(hooksArray) {
  fs.mkdirSync(path.dirname(LOOPS_FILE), { recursive: true });
  fs.writeFileSync(LOOPS_FILE, JSON.stringify(hooksArray, null, 2));
  return hooksArray;
}

// Validate a hooks overlay against the live node set.
//   - slot must be one of before | after | onError
//   - on must be an existing CORE node id
//   - target must be an existing node id (core OR builtin)
//   - no fully-duplicate (on + slot + target) entries
// "next" is NOT part of the payload and is never validated here.
// Throws an Error with a clear message on the first violation; returns the array.
function validateHooks(hooksArray, coreNodeIds, allNodeIds) {
  if (!Array.isArray(hooksArray)) {
    throw new Error("loops.upsert: hooks must be an array");
  }
  const slots = new Set(["before", "after", "onError"]);
  const coreSet = new Set(coreNodeIds);
  const allSet = new Set(allNodeIds);
  const seen = new Set();

  for (let i = 0; i < hooksArray.length; i += 1) {
    const entry = hooksArray[i];
    const where = "hooks[" + i + "]";
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(where + " must be an object { on, slot, target }");
    }
    if (!slots.has(entry.slot)) {
      throw new Error(where + ".slot invalid: '" + entry.slot + "' (expected before|after|onError)");
    }
    if (!coreSet.has(entry.on)) {
      throw new Error(where + ".on invalid: '" + entry.on + "' is not an existing core node");
    }
    if (!allSet.has(entry.target)) {
      throw new Error(where + ".target invalid: '" + entry.target + "' is not an existing node");
    }
    const key = entry.on + "|" + entry.slot + "|" + entry.target;
    if (seen.has(key)) {
      throw new Error(where + " duplicate hook (on+slot+target): " + key);
    }
    seen.add(key);
  }
  return hooksArray;
}

module.exports = { LOOPS_FILE, DEFAULT_HOOKS, readLoops, writeLoops, validateHooks };
