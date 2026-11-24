"use strict";

// Workflow subdomain: owns a run's identity, lifecycle, cancellation and the
// child (subagent) port the script talks to. The script mechanism itself lives
// in lib/workflow-runtime; this module only wires it to the subagent runtime
// and publishes domain events. No persistence here — the tool-call row and the
// event stream carry the run facts (docs/runtime/workflow.md §6).

import crypto from "crypto";
import os from "os";
import { WorkflowError, WorkflowExecution, DEFAULT_LIMITS, validateMeta, compileScript } from "./../../lib/workflow-runtime/index.js";

const ENGINE_VERSION = "worker-vm";
const MAX_RESULT_CHARS = 50000;

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * @param {object} deps
 * @param {object} [deps.config] core config service (readSettings)
 * @param {Function} deps.getSubagents returns the SubagentRuntime (or null)
 * @param {Function} [deps.readWorkflowSettings] overrides config-derived limits
 * @param {Function} [deps.now]
 */
function createWorkflowService({ config, getSubagents, readWorkflowSettings, now = () => new Date() } = {}) {
  const active = new Map(); // runId -> run

  function readSettingsBlock() {
    if (typeof readWorkflowSettings === "function") return readWorkflowSettings() || {};
    try {
      return (config && config.readSettings().workflow) || {};
    } catch (_) {
      return {};
    }
  }

  function readLimits() {
    const block = readSettingsBlock();
    const concurrency = nonNegativeInteger(block.maxConcurrentAgents);
    return {
      maxConcurrentAgents: concurrency && concurrency > 0
        ? concurrency
        : Math.min(16, Math.max(1, os.availableParallelism() - 2)),
      maxTotalAgents: positiveInteger(block.maxTotalAgents) || DEFAULT_LIMITS.maxTotalAgents,
      maxItemsPerCall: positiveInteger(block.maxItemsPerCall) || DEFAULT_LIMITS.maxItemsPerCall,
      syncTimeoutMs: positiveInteger(block.syncTimeoutMs) || DEFAULT_LIMITS.syncTimeoutMs,
      maxResultChars: positiveInteger(block.maxResultChars) || MAX_RESULT_CHARS,
    };
  }

  /**
   * Start one run. Validation failures throw synchronously before a run exists.
   * @param {object} request { script, meta, args?, parent, signal?, onEvent? }
   *        parent: { sessionId, parentChatCtx?, onEvent? }
   * @returns the live run handle
   */
  function start(request) {
    const { script, meta: rawMeta, args, parent, signal, onEvent } = request || {};
    const meta = validateMeta(rawMeta);
    if (typeof script !== "string" || script.length === 0) {
      throw new WorkflowError("workflow script must be a non-empty string", "SCRIPT_PARSE");
    }
    if (/^\s*export\s+const\s+meta\b/.test(script)) {
      throw new WorkflowError(
        "workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body",
        "SCRIPT_PARSE",
      );
    }
    compileScript(script, meta.name);
    const subagents = typeof getSubagents === "function" ? getSubagents() : null;
    if (!subagents || typeof subagents.startChild !== "function") {
      throw new WorkflowError("workflow requires the subagent runtime", "AGENT_START");
    }
    if (!parent || parent.sessionId == null) {
      throw new WorkflowError("workflow requires a calling agent", "INVALID_ARGUMENT");
    }
    const limits = readLimits();
    const id = crypto.randomUUID();
    const info = { id, meta, startedAt: now().toISOString(), engine: ENGINE_VERSION };
    const members = new Map(); // seq -> member record, start order preserved by insertion
    let emissionIndex = 0;
    const emit = (type, payload) => {
      if (typeof onEvent !== "function") return;
      emissionIndex += 1;
      try {
        onEvent({ type: "workflow", runId: id, seq: emissionIndex, event: type, ...payload });
      } catch (_) {
        // A throwing sink never changes execution.
      }
    };
    const childPort = {
      async start(childRequest) {
        // caller delivery: the script awaits this result, so no parent notice is
        // posted and the run's member list is the only record of the child.
        const child = await subagents.startChild({
          delivery: "caller",
          prompt: childRequest.prompt,
          schema: childRequest.schema,
          provider: childRequest.provider,
          model: childRequest.model,
          parentSessionId: parent.sessionId,
          parentChatCtx: parent.parentChatCtx || {},
          parentOnEvent: parent.onEvent,
          workflowRunId: id,
          description: childRequest.label || promptLabel(childRequest.prompt),
        });
        return {
          id: child.childId,
          label: childRequest.label,
          result: child.result,
          dispose: () => child.dispose(),
        };
      },
    };
    const execution = new WorkflowExecution({
      meta,
      body: script,
      args,
      limits,
      childPort,
      observer: {
        phase: (title) => emit("phase", { title }),
        log: (message) => emit("log", { message }),
        agentStart: (agent) => {
          members.set(agent.seq, {
            seq: agent.seq,
            label: agent.label,
            ...(agent.phase !== undefined ? { phase: agent.phase } : {}),
            childId: agent.childId,
            outcome: "running",
          });
          emit("agent-start", { agent });
        },
        agentEnd: (agent) => {
          const member = members.get(agent.seq);
          if (member) member.outcome = agent.outcome;
          emit("agent-end", { agent });
        },
      },
    });

    const run = {
      id,
      meta,
      info,
      limits,
      // Members in start order, as the run's result metadata reports them.
      members: [],
      result: null,
      cancel: (reason) => execution.cancel(reason),
      dispose: null,
    };

    if (signal) {
      if (signal.aborted) execution.cancel("parent step aborted");
      else signal.addEventListener("abort", () => execution.cancel("parent step aborted"), { once: true });
    }

    emit("start", { meta });
    active.set(id, run);

    run.result = execution.drive().then((result) => {
      run.members = [...members.values()].sort((a, b) => a.seq - b.seq);
      emit("end", {
        stopReason: result.stopReason,
        agentsStarted: result.agentsStarted,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      });
      return result;
    });

    run.dispose = () => {
      execution.cancel("workflow disposed");
      return run.result
        .then(() => execution.disposeChildren())
        .then(() => { active.delete(id); });
    };
    return run;
  }

  /** Active runs (diagnostics and teardown). */
  function list() {
    return [...active.values()];
  }

  /** Cancel every active run and await their quiescence. */
  async function disposeAll() {
    const runs = [...active.values()];
    await Promise.all(runs.map((run) => run.dispose().catch(() => {})));
  }

  return { start, list, disposeAll, readLimits };
}

function promptLabel(prompt) {
  const firstLine = String(prompt).split("\n")[0].trim();
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 39)}…`;
}

const __exports = { createWorkflowService };
export { createWorkflowService };
export default __exports;
