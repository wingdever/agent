"use strict";

// Host side of one workflow run. The script executes in a worker thread (see
// script-worker.js) so it can neither block the agent process nor starve it;
// the host owns every resource a script asks for: child subagents, progress
// narration and the terminal result. Children arrive through an injected
// `childPort`:
//
//   port.start({ prompt, schema?, provider?, model?, label, phase, seq })
//     -> { id, result: Promise<{ text, stopReason, structured? }>, dispose() }
//
// Node's default --max-old-space-size counts the whole process, V8 accounting
// includes it, so a runaway in the worker cannot exhaust the host heap.

const path = require("path");
const { Worker } = require("node:worker_threads");
const { WorkflowError, isFatalWorkflowError, workflowResult } = require("./errors");
const { MaterializeError, materializeJson, renderThrown } = require("./realm");

const DEFAULT_LIMITS = Object.freeze({
  maxConcurrentAgents: 0,
  maxTotalAgents: 1000,
  maxItemsPerCall: 4096,
  syncTimeoutMs: 5000,
});

const WORKER_FILE = path.join(__dirname, "script-worker.js");

function wrapBody(body) {
  return `(async () => {\n${body}\n})()`;
}

/** Compile a script on the host (parse only) to reject it before a run exists. */
function compileScript(body, name) {
  try {
    // eslint-disable-next-line no-new
    new (require("vm").Script)(wrapBody(body), { filename: `workflow:${name}`, lineOffset: -1 });
  } catch (error) {
    throw new WorkflowError(`workflow script does not parse: ${renderThrown(error)}`, "SCRIPT_PARSE", { cause: error });
  }
}

function toPlain(value, label) {
  try {
    return materializeJson(value, label);
  } catch (error) {
    if (!(error instanceof MaterializeError)) throw error;
    throw new WorkflowError(`${label} must be plain JSON data — ${error.message}`, "INVALID_ARGUMENT", { cause: error });
  }
}

class WorkflowExecution {
  /**
   * @param {object} options
   * @param {object} options.meta validated identity block
   * @param {string} options.body script body
   * @param {unknown} options.args value exposed as the `args` global
   * @param {object} options.limits resolved cooperative limits
   * @param {object} options.observer { phase, log, agentStart, agentEnd }
   * @param {object} options.childPort injected subagent port
   */
  constructor({ meta, body, args, limits, observer, childPort }) {
    this.meta = meta;
    this.body = body;
    this.args = args;
    this.limits = Object.assign({}, DEFAULT_LIMITS, limits || {});
    this.observer = observer || {};
    this.childPort = childPort;
    this.started = 0;
    this.children = new Map(); // seq -> child handle
    this.disposed = 0; // children whose disposal completed (diagnostics)
    this.worker = null;
    this.settled = false;
    this.cancelReason = undefined;
    this.cancelled = false;
    compileScript(body, meta.name);
  }

  /**
   * Cancel the script: stop the worker and dispose every child that is
   * starting or running. Idempotent; the first reason wins.
   * @param {string} [reason]
   */
  cancel(reason) {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason || "workflow cancelled";
    if (this.worker) {
      // Ask the worker to abandon the script; it answers with a cancelled
      // result, and that answer (or the worker's exit) terminates it. Killing
      // it here would drop the answer drive() is waiting for.
      try {
        this.worker.postMessage({ t: "stop" });
      } catch (_) {
        this._terminate();
      }
    }
    void this.disposeChildren();
  }

  _terminate() {
    if (!this.worker) return;
    const worker = this.worker;
    this.worker = null;
    try {
      worker.removeAllListeners();
    } catch (_) { /* ignore */ }
    // A `terminate()` promise that never settles must not hold the process.
    worker.unref();
    void Promise.resolve(worker.terminate()).catch(() => {});
  }

  _emit(name, ...args) {
    const fn = this.observer[name];
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch (_) {
      // Observers are advisory: a throwing listener never changes execution.
    }
  }

  /**
   * Run the script and materialize its JSON return value.
   * @returns {Promise<object>} a terminal result; never rejects
   */
  drive() {
    return new Promise((resolve) => {
      const finish = (result) => {
        if (this.settled) return;
        this.settled = true;
        this._terminate();
        resolve(result);
      };
      let worker;
      try {
        worker = new Worker(WORKER_FILE, {
          resourceLimits: {
            maxOldGenerationSizeMb: 512,
            maxYoungGenerationSizeMb: 64,
            stackSizeMb: 8,
          },
        });
        // The worker keeps the event loop alive while the script runs, but it
        // must never be the reason the process stays up: an abandoned run is
        // cancelled by dispose()/the parent turn, not by process lifetime.
        worker.unref();
      } catch (error) {
        finish(workflowResult({ value: null, stopReason: "error", error: `workflow worker could not start: ${renderThrown(error)}`, errorCode: "RUN_FAILED", agentsStarted: 0 }));
        return;
      }
      this.worker = worker;
      worker.on("message", (message) => this._onWorkerMessage(message, finish));
      worker.on("error", (error) => {
        finish(this.cancelled
          ? this._cancelledResult()
          : workflowResult({ value: null, stopReason: "error", error: renderThrown(error), errorCode: "RUN_FAILED", agentsStarted: this.started }));
      });
      worker.on("exit", () => {
        if (this.settled) return;
        finish(this.cancelled
          ? this._cancelledResult()
          : workflowResult({ value: null, stopReason: "error", error: "workflow worker exited before the script settled", errorCode: "RUN_FAILED", agentsStarted: this.started }));
      });
      const init = { meta: this.meta, body: this.body, limits: this.limits };
      if (this.args !== undefined) init.args = toPlain(this.args, "workflow args");
      worker.postMessage({ t: "init", init });
    });
  }

  _cancelledResult() {
    return workflowResult({
      value: null,
      stopReason: "cancelled",
      error: `workflow run cancelled: ${this.cancelReason}`,
      errorCode: "CANCELLED",
      agentsStarted: this.started,
    });
  }

  _onWorkerMessage(message, finish) {
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "phase":
        this._emit("phase", String(message.title));
        return;
      case "log":
        this._emit("log", String(message.message));
        return;
      case "agent-start":
        void this._startChild(message);
        return;
      case "result":
        finish(this._materialize(message));
        return;
      default:
        return;
    }
  }

  _materialize(message) {
    if (this.cancelled || message.cancelled === true) return this._cancelledResult();
    const agentsStarted = Number.isInteger(message.agentsStarted) ? message.agentsStarted : this.started;
    if (!message.ok) {
      return workflowResult({
        value: null,
        stopReason: "error",
        error: String(message.error),
        errorCode: message.code,
        agentsStarted,
      });
    }
    let value;
    try {
      value = materializeJson(message.value, "workflow result");
    } catch (error) {
      if (!(error instanceof MaterializeError)) throw error;
      return workflowResult({
        value: null,
        stopReason: "error",
        error: `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        errorCode: "RESULT_UNSERIALIZABLE",
        agentsStarted,
      });
    }
    return workflowResult({ value, stopReason: "completed", agentsStarted });
  }

  async _startChild(message) {
    const seq = message.seq;
    if (this.cancelled) {
      this._post({ t: "agent-end", seq, outcome: "cancelled" });
      return;
    }
    this.started = Math.max(this.started, seq);
    let child;
    try {
      child = await this.childPort.start({
        seq,
        prompt: message.prompt,
        label: message.label,
        phase: message.phase,
        schema: message.schema,
        provider: message.provider,
        model: message.model,
      });
    } catch (error) {
      this._post({ t: "agent-end", seq, startError: renderThrown(error) });
      return;
    }
    // Registered as soon as it exists: cancel() disposes whatever is in here,
    // then _startChild's own cancellation check takes over.
    this.children.set(seq, child);
    const info = { seq, label: child.label || message.label, ...(message.phase !== undefined ? { phase: message.phase } : {}), childId: child.id };
    this._emit("agentStart", info);
    if (this.cancelled) {
      await this._disposeChild(seq, child);
      this._post({ t: "agent-end", seq, outcome: "cancelled" });
      return;
    }
    try {
      const result = await child.result;
      const settled = { seq };
      if (result && result.stopReason === "completed") {
        settled.stopReason = "completed";
        settled.text = typeof result.text === "string" ? result.text : "";
        if (result.structured !== undefined) {
          try {
            settled.structured = materializeJson(result.structured, "structured result");
          } catch (_) {
            // An unserializable structured value is a child fault: the script
            // sees null, not an infrastructure error.
          }
        }
      } else {
        settled.stopReason = (result && result.stopReason) || "error";
      }
      const outcome = settled.stopReason === "completed" && (message.schema === undefined || settled.structured !== undefined)
        ? "completed"
        : "failed";
      this._emit("agentEnd", Object.assign({}, info, { outcome: this.cancelled ? "cancelled" : outcome }));
      this._post(this.cancelled ? { t: "agent-end", seq, outcome: "cancelled" } : Object.assign({ t: "agent-end" }, settled));
    } catch (error) {
      this._emit("agentEnd", Object.assign({}, info, { outcome: this.cancelled ? "cancelled" : "failed" }));
      this._post({ t: "agent-end", seq, resultError: renderThrown(error) });
    } finally {
      await this._disposeChild(seq, child);
    }
  }

  async _disposeChild(seq, child) {
    this.children.delete(seq);
    try {
      await child.dispose();
    } catch (_) {
      // A disposal failure never changes the script-visible outcome.
    }
    this.disposed += 1;
  }

  _post(message) {
    if (!this.worker || this.settled) return;
    try {
      this.worker.postMessage(message);
    } catch (_) { /* worker already gone: the run is settling anyway */ }
  }

  /** Dispose every child that is still starting or running. */
  async disposeChildren() {
    const pending = [...this.children.entries()];
    await Promise.all(pending.map(([seq, child]) => this._disposeChild(seq, child)));
  }
}

module.exports = { WorkflowExecution, DEFAULT_LIMITS, compileScript, wrapBody };
