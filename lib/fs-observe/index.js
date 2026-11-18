"use strict";

// Per-session file observation, mirroring DSH's fs-observation-policy:
// - read records "present at version <mtimeMs>:<size>" (or "absent").
// - write requires a prior observation for an existing file, and only replaces
//   the version that was observed.
// - edit requires a prior present observation.
// This is what makes "read before overwrite/edit" real instead of a prompt hint.

const sessions = new Map();

function keyFor(sessionId) {
  return sessionId == null || sessionId === "" ? "__bare__" : String(sessionId);
}

function mapFor(sessionId) {
  const key = keyFor(sessionId);
  let map = sessions.get(key);
  if (!map) {
    map = new Map();
    sessions.set(key, map);
  }
  return map;
}

function versionOf(info) {
  return info.mtimeMs + ":" + info.size;
}

function record(sessionId, absPath, info) {
  const map = mapFor(sessionId);
  if (!info) {
    map.set(absPath, { kind: "absent" });
    return;
  }
  map.set(absPath, { kind: "present", version: versionOf(info) });
}

function prior(sessionId, absPath) {
  return mapFor(sessionId).get(absPath);
}

function assertVersion(sessionId, absPath, info, displayPath, verb) {
  const observed = prior(sessionId, absPath);
  if (!info) {
    if (verb === "write" && observed && observed.kind === "present") {
      throw new Error('cannot write "' + displayPath + '": file no longer exists');
    }
    if (verb === "edit") throw new Error('cannot edit "' + displayPath + '": not found');
    return;
  }
  if (!observed) {
    if (verb === "edit") throw new Error('edit requires reading "' + displayPath + '" first');
    throw new Error('cannot overwrite existing "' + displayPath + '" without reading it first');
  }
  if (observed.kind !== "present") {
    if (verb === "edit") throw new Error('cannot edit "' + displayPath + '": not found');
    throw new Error('cannot write "' + displayPath + '": file changed since it was read');
  }
  if (observed.version !== versionOf(info)) {
    throw new Error('cannot ' + verb + ' "' + displayPath + '": file changed since it was read');
  }
}

function reset(sessionId) {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(keyFor(sessionId));
}

module.exports = { record, assertVersion, reset, versionOf };
