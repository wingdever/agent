"use strict";

// TurnState: the per-turn delivery state held at Agent.turn (docs/agents/
// agent-instance.md §2-3). It describes where this turn emits events and under
// what authorization it runs; it has no cross-turn semantics and is nulled at
// turn end. The turn-wide data container (request / step / system / conv) is a
// separate concern and is not named TurnState here. Contract only: no consumer
// is wired yet.

function createTurnState(opts = {}) {
  return {
    emit: opts.emit != null ? opts.emit : () => {},
    autonomy: opts.autonomy != null ? opts.autonomy : "supervised",
    effort: opts.effort != null ? opts.effort : null,
    activity: opts.activity != null ? opts.activity : "bare-chat",
    interactions: opts.interactions != null ? opts.interactions : null,
    steps: opts.steps != null ? opts.steps : 0,
    toolsUsed: opts.toolsUsed != null ? opts.toolsUsed : 0,
    startedAt: opts.startedAt != null ? opts.startedAt : 0,
  };
}

const __exports = { createTurnState };
export { createTurnState };
export default __exports;
