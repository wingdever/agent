"use strict";

// AgentState: the second segment of the three-part Agent construction
// (docs/agents/agent-instance.md §4). It is the explicit initial-value manifest
// of an instance's in-process runtime state — a factory, not a data object to
// be new'ed and passed around. Things that are session facts live in store;
// things that are process gates live in their own Maps. Contract only: no
// AgentRegistry / Agent consumer is wired yet.

function createAgentState(opts = {}) {
  return {
    // 身份（来自 store，只读）
    sessionId: opts.sessionId != null ? opts.sessionId : null,
    kind: opts.kind != null ? opts.kind : "normal",
    parentSessionId: opts.parentSessionId != null ? opts.parentSessionId : null,
    agentName: opts.agentName != null ? opts.agentName : "lead",
    persist: opts.persist === true,

    // 运行态（实例存续）
    phase: opts.phase != null ? opts.phase : { kind: "idle" },
    inbox: opts.inbox != null ? opts.inbox : { nextTurn: [], nextStep: [] },
    planMode: opts.planMode === true,
    todos: opts.todos != null ? opts.todos : [],

    // 每轮投递态，轮内非 null，轮末置 null（见 createTurnState）
    turn: opts.turn != null ? opts.turn : null,
  };
}

module.exports = { createAgentState };
