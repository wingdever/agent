"use strict";

// Model-facing whole-list replacement. The projection lives for one turn and
// resets when the next turn starts (core/todo-state.js).

const { set } = require("../../core/todo-state");

const STATUSES = new Set(["pending", "in_progress", "completed"]);

module.exports = {
  async run(args = {}, exec = {}) {
    if (!Array.isArray(args.todos)) throw new Error("todos must be an array");
    const todos = [];
    const seen = new Set();
    for (const item of args.todos) {
      if (!item || typeof item !== "object") throw new Error("each todo must be an object");
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!content) throw new Error("invalid todo: `content` must be a non-empty string");
      if (seen.has(content)) throw new Error('invalid todos: duplicate content ' + JSON.stringify(content));
      seen.add(content);
      if (!STATUSES.has(item.status)) {
        throw new Error("invalid todo status " + JSON.stringify(item.status));
      }
      todos.push({ content, status: item.status });
    }

    const counts = { pending: 0, inProgress: 0, completed: 0 };
    for (const todo of todos) {
      if (todo.status === "pending") counts.pending += 1;
      else if (todo.status === "in_progress") counts.inProgress += 1;
      else counts.completed += 1;
    }

    set(exec.sessionId, todos);
    return {
      text:
        "Updated todo list: " + counts.pending + " pending, " +
        counts.inProgress + " in progress, " + counts.completed + " completed.",
      meta: { todos, counts },
    };
  },
};
