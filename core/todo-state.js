"use strict";

// Per-turn task list projection. DSH resets the todo projection on turn/start
// and keeps it for the whole turn; this module mirrors that with an in-memory
// map. Durable replay is not provided yet; the latest list is in the tool
// result's meta and in the tool call arguments.

const lists = new Map();

function keyFor(sessionId) {
  return sessionId == null || sessionId === "" ? "__bare__" : String(sessionId);
}

function reset(sessionId) {
  if (sessionId === undefined) lists.clear();
  else lists.delete(keyFor(sessionId));
}

function get(sessionId) {
  return lists.get(keyFor(sessionId)) || null;
}

function set(sessionId, todos) {
  lists.set(keyFor(sessionId), todos);
  return todos;
}

module.exports = { reset, get, set };
