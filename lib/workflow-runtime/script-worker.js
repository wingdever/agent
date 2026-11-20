"use strict";

// Worker-side entry: run one workflow script body inside a vm context whose
// global carries only the six hooks and `args`. Hooks talk to the host over
// worker messages, so the script cannot block the agent process, read its
// state, or fabricate a fatal error.
//
// Protocol (this side is the script/guest):
//   in  init                 -> run the body
//   out agent-start          -> host publishes a child, or answers agent-error
//   out agent-dispose        -> host disposes that child (after the call settled)
//   out phase / log
//   out result               -> terminal outcome; the host stops the worker
//   in  agent-end            -> settles the matching agent() promise

const vm = require("node:vm");
const { parentPort } = require("node:worker_threads");
const { assertObjectJsonSchema } = require("./schema");
const { materializeJson } = require("./realm");

// Fatality must survive the realm boundary: `instanceof` against this realm's
// class does not hold for values the host built, so a private symbol marks the
// host's own errors. A script cannot reach the symbol.
const FATAL = Symbol.for("deepseek-agent.workflow.fatal");
const SUPPORTED_AGENT_OPTIONS = ["label", "phase", "schema", "provider", "model"];
const DEFERRED_AGENT_OPTIONS = ["effort", "isolation", "agentType"];

class WorkflowError extends Error {
  constructor(message, code, options) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.fatal = !options || options.fatal !== false;
  }
}
Object.defineProperty(WorkflowError.prototype, FATAL, { value: true, enumerable: false });

function isFatalWorkflowError(error) {
  if (error instanceof WorkflowError) return error.fatal === true;
  return !!(error && typeof error === "object" && error[FATAL] === true && error.fatal === true);
}

function renderThrown(error) {
  try {
    const stack = error && error.stack;
    if (typeof stack === "string" && stack.length > 0) return stack;
    const message = error && error.message;
    if (typeof message === "string" && message.length > 0) return message;
    return String(error);
  } catch (_) {
    return "[unrenderable thrown value]";
  }
}

function defaultLabel(prompt) {
  const newline = prompt.indexOf("\n");
  const line = newline === -1 ? prompt : prompt.slice(0, newline);
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`;
}

function send(message) {
  parentPort.postMessage(message);
}

// ---- run state ----

const state = {
  limits: null,
  started: 0,
  activeSlots: 0,
  slotWaiters: [],
  currentPhase: undefined,
  pending: new Map(), // seq -> { resolve, family }
  done: false,
};

function acquireSlot() {
  const limit = state.limits.maxConcurrentAgents;
  if (limit <= 0 || state.activeSlots < limit) {
    state.activeSlots += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.slotWaiters.push(() => {
      state.activeSlots += 1;
      resolve();
    });
  });
}

function releaseSlot() {
  state.activeSlots -= 1;
  const next = state.slotWaiters.shift();
  if (next) next();
}

function assertItemCap(length, hook) {
  if (length > state.limits.maxItemsPerCall) {
    throw new WorkflowError(
      `${hook} received ${length} items — over the per-call cap (${state.limits.maxItemsPerCall}); split the work or raise maxItemsPerCall in the engine config`,
      "ITEM_CAP",
    );
  }
}

function checkAgentOptions(opts) {
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
    throw new WorkflowError("agent() options must be an object", "INVALID_ARGUMENT");
  }
  for (const key of Object.keys(opts)) {
    if (SUPPORTED_AGENT_OPTIONS.includes(key)) continue;
    if (DEFERRED_AGENT_OPTIONS.includes(key)) {
      throw new WorkflowError(`agent() option "${key}" is deferred and not supported by this engine (supported: ${SUPPORTED_AGENT_OPTIONS.join(", ")})`, "UNSUPPORTED_OPTION");
    }
    throw new WorkflowError(`agent() option "${key}" is not recognized (supported: ${SUPPORTED_AGENT_OPTIONS.join(", ")})`, "UNSUPPORTED_OPTION");
  }
  for (const key of ["label", "phase", "provider", "model"]) {
    if (opts[key] !== undefined && typeof opts[key] !== "string") {
      throw new WorkflowError(`agent() option "${key}" must be a string`, "INVALID_ARGUMENT");
    }
  }
  if (opts.schema !== undefined) assertObjectJsonSchema(opts.schema);
}

// Wait for the host's settlement of one agent() call.
function awaitSettlement(seq) {
  return new Promise((resolve) => { state.pending.set(seq, resolve); });
}

// ---- hooks ----

async function agentHook(prompt, rawOpts) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new WorkflowError("agent() requires a non-empty prompt string", "INVALID_ARGUMENT");
  }
  const opts = rawOpts === undefined ? {} : rawOpts;
  checkAgentOptions(opts);
  if (state.started >= state.limits.maxTotalAgents) {
    throw new WorkflowError(
      `this run reached its total agent cap (${state.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`,
      "AGENT_CAP",
    );
  }
  state.started += 1;
  const seq = state.started;
  const label = opts.label !== undefined ? opts.label : defaultLabel(prompt);
  const phase = opts.phase !== undefined ? opts.phase : state.currentPhase;

  await acquireSlot();
  const settlement = awaitSettlement(seq);
  send({
    t: "agent-start",
    seq,
    prompt,
    label,
    ...(phase !== undefined ? { phase } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  try {
    const reply = await settlement;
    if (reply.resultError !== undefined) {
      // Infrastructure fault relayed by the host: fatal, never a child result.
      throw new WorkflowError(`child agent run failed: ${reply.resultError}`, "AGENT_RESULT");
    }
    if (reply.startError !== undefined) {
      throw new WorkflowError(`agent() could not start a child: ${reply.startError}`, "AGENT_START");
    }
    if (reply.stopReason === "completed") {
      if (opts.schema !== undefined) return reply.structured !== undefined ? reply.structured : null;
      return typeof reply.text === "string" ? reply.text : "";
    }
    return null;
  } finally {
    state.pending.delete(seq);
    releaseSlot();
  }
}

async function parallelHook(thunks) {
  if (!Array.isArray(thunks)) throw new WorkflowError("parallel() requires an array of zero-argument functions", "INVALID_ARGUMENT");
  assertItemCap(thunks.length, "parallel()");
  for (let index = 0; index < thunks.length; index += 1) {
    if (typeof thunks[index] !== "function") throw new WorkflowError(`parallel() item ${index} is not a function`, "INVALID_ARGUMENT");
  }
  return Promise.all(thunks.map(async (thunk) => {
    try {
      return await thunk();
    } catch (error) {
      if (isFatalWorkflowError(error)) throw error;
      return null;
    }
  }));
}

async function pipelineHook(items, ...stages) {
  if (!Array.isArray(items)) throw new WorkflowError("pipeline() requires an items array", "INVALID_ARGUMENT");
  assertItemCap(items.length, "pipeline()");
  if (stages.length === 0) throw new WorkflowError("pipeline() requires at least one stage function", "INVALID_ARGUMENT");
  for (let index = 0; index < stages.length; index += 1) {
    if (typeof stages[index] !== "function") throw new WorkflowError(`pipeline() stage ${index} is not a function`, "INVALID_ARGUMENT");
  }
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    try {
      for (const stage of stages) value = await stage(value, item, index);
      return value;
    } catch (error) {
      if (isFatalWorkflowError(error)) throw error;
      return null;
    }
  }));
}

function phaseHook(title) {
  if (typeof title !== "string" || title.length === 0) {
    throw new WorkflowError("phase() requires a non-empty title string", "INVALID_ARGUMENT");
  }
  state.currentPhase = title;
  send({ t: "phase", title });
}

function logHook(message) {
  if (typeof message !== "string") throw new WorkflowError("log() requires a message string", "INVALID_ARGUMENT");
  send({ t: "log", message });
}

function contain(promise) {
  promise.catch(() => {});
  return promise;
}

// ---- driver ----

function settle(payload) {
  if (state.done) return;
  state.done = true;
  send({ t: "result", ...payload });
}

function runScript(init) {
  state.limits = init.limits;
  const context = vm.createContext({}, { name: `workflow:${init.meta.name}` });
  const globals = {
    agent: (prompt, opts) => contain(agentHook(prompt, opts)),
    parallel: (thunks) => contain(parallelHook(thunks)),
    pipeline: (items, ...stages) => contain(pipelineHook(items, ...stages)),
    phase: phaseHook,
    log: logHook,
    args: init.args,
  };
  for (const [key, value] of Object.entries(globals)) {
    context[key] = typeof value === "function" ? Object.freeze(value) : value;
  }
  let script;
  try {
    script = new vm.Script(`(async () => {\n${init.body}\n})()`, { filename: `workflow:${init.meta.name}`, lineOffset: -1 });
  } catch (error) {
    settle({ ok: false, error: `workflow script does not parse: ${renderThrown(error)}`, code: "SCRIPT_PARSE", agentsStarted: 0 });
    return;
  }
  Promise.resolve()
    .then(() => script.runInContext(context, { timeout: init.limits.syncTimeoutMs }))
    .then(
      (value) => {
        // Materialize before crossing postMessage: structured clone would
        // otherwise fail first with an opaque DataCloneError.
        let plain;
        try {
          plain = materializeJson(value === undefined ? null : value, "workflow result");
        } catch (error) {
          settle({
            ok: false,
            error: `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
            code: "RESULT_UNSERIALIZABLE",
            agentsStarted: state.started,
          });
          return;
        }
        settle({ ok: true, value: plain, agentsStarted: state.started });
      },
      (error) => settle({ ok: false, error: renderThrown(error), code: error && error.code ? error.code : undefined, agentsStarted: state.started }),
    );
}

// Host-initiated cancellation. The script is abandoned where it stands — its
// pending agent() calls never settle — and the worker reports the cancellation
// itself. Throwing an error back into the script instead would let it catch
// and continue, or strand the driver on a promise nobody settles.
function stop() {
  if (state.done) return;
  // settle() sets `done`; clearing first lets a concurrent script completion
  // (if any) win the race, which is also a legal settlement.
  settle({ ok: false, cancelled: true, error: "workflow run was cancelled", code: "CANCELLED", agentsStarted: state.started });
  state.pending.clear();
}

parentPort.on("message", (message) => {
  switch (message.t) {
    case "init":
      runScript(message.init);
      break;
    case "agent-end": {
      const resolve = state.pending.get(message.seq);
      if (resolve) resolve(message);
      break;
    }
    case "stop":
      stop();
      break;
    default:
      break;
  }
});
