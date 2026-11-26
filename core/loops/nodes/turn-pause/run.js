"use strict";

// Node turn-pause: the one pause point (docs/runtime/turn-pause.md §1.1,
// §2.1). The loop reaches it right after pre-step, when a pause has been
// requested or a restored paused turn is being continued.
//
// It decides which pause point this is, stops here until the turn is
// continued, and then sends the turn on to whatever comes after that point. A
// turn stopped after a tool-bearing model response is a `before-tools` pause:
// those tools are the ones waiting to run. Every other arrival is a
// `before-model` pause: the next thing that would happen is a model request.
export default async function run(input, ctx) {
  const { agent } = ctx;
  const pausedAt = ctx.step && ctx.step.response && Array.isArray(ctx.step.response.tool_calls)
    && ctx.step.response.tool_calls.length > 0
    ? "before-tools"
    : "before-model";

  await agent.pauseAt(pausedAt);
  // Continue from where the turn stopped: a turn stopped before its tools runs
  // them now; every other pause continues with the model request (docs/runtime/
  // turn-pause.md §1.4). Continuing must never repeat the request that
  // produced the stopped batch.
  return { output: input, next: pausedAt === "before-tools" ? "tool-execute" : "model-call" };
};
