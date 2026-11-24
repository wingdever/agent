"use strict";

// Todo projection primitives over the owning agent instance. The list is
// instance state (`agent.todos`); this module only reads and writes it, so there
// is no process-level key table. DSH resets the projection on turn/start and
// keeps it for the whole turn: core's turn-start node calls reset(), and the
// todo_write tool calls set().

function reset(agent) {
  if (agent) agent.resetTodos();
}

function get(agent) {
  if (!agent) return null;
  return agent.todos && agent.todos.length ? agent.todos : null;
}

function set(agent, todos) {
  if (!agent) return null;
  return agent.setTodos(todos);
}

const __exports = { reset, get, set };
export { reset, get, set };
export default __exports;
