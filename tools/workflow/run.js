"use strict";

// `workflow` 工具（docs/runtime/workflow.md）：把模型写的编排脚本交给
// core/workflow 起一个 run，等它落定，把返回值渲染成一次工具结果。
// 前台阻塞到整段脚本落定；后台立即返回 job id，返回值随完成通知到达。

const { DEFAULT_RESULT_CHARS, renderCompletion, renderProgress, resultMeta, stopReasonError } = require("./render");

async function run(args, exec) {
  const engine = exec && exec.workflowEngine;
  if (!engine || typeof engine.start !== "function") {
    return { text: "Error: workflow orchestration is unavailable in this context", isError: true };
  }
  const { script, meta, args: workflowArgs, run_in_background: background } = args || {};

  if (background === true) return runInBackground({ engine, exec, script, meta, workflowArgs });

  // Meta/body validation failures throw synchronously here and become isError
  // results through the tool executor: the model sees the violation list and
  // can correct the call.
  const live = engine.start({
    script,
    meta,
    args: workflowArgs,
    onEvent: (event) => emitProgress(exec, event),
  });
  try {
    const result = await live.result;
    const failure = stopReasonError(result);
    if (failure) {
      if (exec.signal && exec.signal.aborted) return { text: "Error: tool call aborted", isError: true };
      return { text: "Error: " + failure, isError: true };
    }
    return {
      text: renderCompletion(live.meta.name, result.agentsStarted, result.value, maxChars(exec)),
      meta: resultMeta(live, result),
    };
  } finally {
    await live.dispose().catch(() => {});
  }
}

// Background runs need a job registry; this build has none, so the call fails
// with the missing piece named rather than silently blocking the turn.
async function runInBackground({ engine, exec, script, meta, workflowArgs }) {
  if (!exec || typeof exec.startJob !== "function") {
    return {
      text: "Error: background workflow runs require a job registry, which this build does not provide; omit run_in_background",
      isError: true,
    };
  }
  const started = await exec.startJob({
    kind: "workflow",
    label: meta && meta.name,
    run: (job) => {
      const live = engine.start({
        script,
        meta,
        args: workflowArgs,
        onEvent: (event) => {
          emitProgress(exec, event);
          const line = renderProgress(event);
          if (line) job.append(line);
        },
      });
      return {
        done: live.result.then(async (result) => {
          await live.dispose().catch(() => {});
          if (result.stopReason === "completed") {
            return {
              status: "completed",
              detail: `${result.agentsStarted} agent${result.agentsStarted === 1 ? "" : "s"}`,
              result: renderCompletion(live.meta.name, result.agentsStarted, result.value, maxChars(exec)),
            };
          }
          if (result.stopReason === "cancelled") return { status: "killed" };
          return { status: "failed", detail: result.error || "unknown error" };
        }),
      };
    },
  });
  return `workflow "${meta.name}" started in the background as job ${started.jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`;
}

function maxChars(exec) {
  return (exec && exec.maxResultChars) || DEFAULT_RESULT_CHARS;
}

// Progress is advisory: the UI may render it, a sink that throws never changes
// the run. The model sees only the final result.
function emitProgress(exec, event) {
  if (!exec || typeof exec.emit !== "function") return;
  try {
    exec.emit({
      type: "workflow-progress",
      runId: event.runId,
      event: event.event,
      seq: event.seq,
      title: event.title,
      message: event.message,
      agent: event.agent,
    });
  } catch (_) { /* advisory */ }
}

module.exports = { run, renderProgress };
