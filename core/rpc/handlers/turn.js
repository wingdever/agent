"use strict";

// Turn control surface (docs/runtime/turn-pause.md §3.2): pause, continue and
// observe the current turn. Pausing is a request; it takes effect at the next
// pause point, which the loop owns. There is deliberately no `turn.cancel`
// here: stopping is not pausing, and the runtime's own cancellation stays in
// the loop.

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };

const turnState = {
  type: "object",
  properties: { session_id: anyId },
  required: ["session_id"],
  additionalProperties: false,
};

const turnPause = {
  type: "object",
  properties: { session_id: anyId },
  required: ["session_id"],
  additionalProperties: false,
};

const turnResume = {
  type: "object",
  properties: {
    session_id: anyId,
    message: { type: "string" },
  },
  required: ["session_id"],
  additionalProperties: false,
};

// The turn's unfinished step: the assistant reply of its last step and the
// calls of that reply that have not run yet. A turn stopped before its tools
// still has them all in `calls` with status 'pending'.
async function turnProgress(core, sessionId) {
  const turns = await core.store.run("turn.list", { session_id: sessionId }).catch(() => []);
  const open = (turns || []).filter((turn) => turn.status === "pending" || turn.status === "running");
  const turn = open[open.length - 1];
  if (!turn) return { turnId: null, step: null, calls: [] };
  const steps = await core.store.run("step.list", { turn_id: turn.id }).catch(() => []);
  const step = (steps || [])[steps.length - 1];
  if (!step) return { turnId: turn.id, step: null, calls: [] };
  const messages = await core.store.run("message.list", { step_id: step.id }).catch(() => []);
  const reply = (messages || []).filter((message) => message.role === "assistant").pop();
  if (!reply) return { turnId: turn.id, step: { id: step.id, seq: step.seq }, calls: [] };
  const calls = await core.store.run("call.list", { reply_id: reply.id }).catch(() => []);
  return {
    turnId: turn.id,
    step: { id: step.id, seq: step.seq, messageSeq: (messages || []).length },
    calls: (calls || []).map((call) => ({ callId: call.call_id, name: call.name, arguments: call.arguments, status: call.status })),
  };
}

function view(agent, progress) {
  const kind = agent ? agent.phase.kind : "idle";
  const paused = kind === "paused" && agent;
  return {
    sessionId: agent ? agent.sessionId : null,
    turnId: progress ? progress.turnId : null,
    phase: kind,
    pausedAt: paused ? agent.pause.pausedAt : null,
    nextNode: paused ? agent.pause.node : kind === "running" ? "running" : null,
    pendingCalls: paused && agent.pause.pausedAt === "before-tools" && progress
      ? progress.calls.filter((call) => call.status === "pending")
      : [],
  };
}

export default function defineTurnCommands(rpc) {
  rpc.define({
    name: "turn.state",
    params: turnState,
    handler: async (core, params) => {
      const agent = core.agent.get(params.session_id);
      if (!agent) {
        return { sessionId: params.session_id, turnId: null, phase: "idle", pausedAt: null, nextNode: null, pendingCalls: [] };
      }
      const progress = agent.phase.kind === "paused" ? await turnProgress(core, params.session_id) : null;
      return view(agent, progress);
    },
  });

  rpc.define({
    name: "turn.pause",
    params: turnPause,
    handler: (core, params) => {
      const agent = core.agent.get(params.session_id);
      return { requested: agent ? agent.requestPause() : false };
    },
  });

  rpc.define({
    name: "turn.resume",
    params: turnResume,
    handler: async (core, params) => {
      const agent = core.agent.get(params.session_id);
      if (!agent) return { resumed: false };
      const message = typeof params.message === "string" && params.message.trim()
        ? { content: params.message, source: "user_input" }
        : null;
      // Captured before resuming: a restored pause keeps it, a live pause clears it.
      const continuing = agent.pause.continueAt;
      const resumed = agent.resumeTurn({ message });
      if (!resumed) return { resumed: false };
      // A restored paused turn has no live loop holding it: continuing starts
      // the turn itself. A pause reached inside a live turn is merely
      // released, and its loop carries on.
      if (continuing && typeof core.agent.resumeTurn === "function") {
        agent.resumeTurnLoop = core.agent.resumeTurn(agent);
      }
      const pending = await turnProgress(core, params.session_id).catch(() => null);
      return { resumed: true, state: view(agent, pending) };
    },
  });
}
