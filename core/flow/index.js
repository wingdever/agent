"use strict";

// Flow subdomain: user-edited node graphs, executed by the local backend.
//
// This is a separate layer from the workflow tool. A workflow is a script the
// MODEL writes for one task; a flow is a graph the USER edits and keeps. They
// share capabilities (the model service, the tool executor) but neither calls
// the other, and no flow run touches an Agent instance: nodes get a narrow
// context built here (one model call, one tool call) and nothing else.
//
// See docs/flow/flow.md for the data model and the execution model.

import crypto from "crypto";
import path from "path";
import { validateFlow } from "./validate.js";
import { executeFlow } from "./execute.js";
import { describeNodeTypes } from "./nodes.js";
import { PROJECT_ROOT } from "./../../lib/paths/index.js";

/** Default ceiling on agent-free model output for a flow node. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * @param {object} deps
 * @param {object} deps.store storage service
 * @param {object} deps.model model service (ModelService)
 * @param {object} deps.config core config service
 * @param {object} deps.tools ToolService
 * @param {Function} deps.runTool the tool executor's runTool(tool, args, exec)
 * @param {object} [deps.capabilities] proxy/skill handles exposed to tools
 * @param {object} [deps.browser] browser service for browser_* tools
 */
function createFlowService({ store, model, config, tools, runTool, capabilities = null, browser = null }) {
  const active = new Map(); // runId -> AbortController

  function resolveTarget(data) {
    const target = config.resolveTarget({
      provider: data && data.provider,
      model: data && data.model,
    });
    return target;
  }

  function nodeContext(flow, runId) {
    const workdir = flow.definition && flow.definition.workdir
      ? path.resolve(PROJECT_ROOT, flow.definition.workdir)
      : PROJECT_ROOT;
    return {
      resolveTarget,
      stream: async ({ messages, target, maxTokens }) => {
        return model.stream({
          messages,
          toolDefs: [],
          model: target.model,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          effort: null,
          onEvent: () => {},
          sessionId: null,
          stream: false,
          maxTokens: maxTokens != null ? maxTokens : DEFAULT_MAX_TOKENS,
        });
      },
      tools,
      runTool: (tool, args) => runTool(tool, args, {
        // A flow run belongs to no session and no turn: tools that need a
        // session id (fs-observe bookkeeping) degrade to null, and capabilities
        // the executor does not provide are simply absent.
        cwd: workdir,
        sessionId: null,
        callId: `flow-${runId}-${crypto.randomUUID().slice(0, 8)}`,
        isPlanMode: () => false,
        store,
        capabilities,
        browser,
      }),
    };
  }

  /**
   * Save a flow definition (validate first; store verbatim).
   * @returns {{ ok: boolean, violations?: string[], flow?: object }}
   */
  async function save({ id, name, description, definition }) {
    const checked = validateFlow(definition);
    if (!checked.ok) return { ok: false, violations: checked.violations };
    const text = JSON.stringify(checked.definition);
    const row = id == null
      ? await store.run("flow.create", { name: name || "untitled", description: description || "", definition: text })
      : await store.run("flow.update", { id, name: name || "untitled", description: description || "", definition: text });
    return { ok: true, flow: row };
  }

  /**
   * Execute one saved flow. The run row is created first so a crash leaves
   * evidence; node rows are written as each node settles.
   * @returns {Promise<{ status, output?, error?, runId }>}
   */
  async function run({ flowId, input, onEvent = () => {} }) {
    const flowRow = await store.run("flow.get", { id: flowId });
    if (!flowRow) throw new Error("flow not found: " + flowId);
    let definition;
    try {
      definition = JSON.parse(flowRow.definition);
    } catch (error) {
      throw new Error("flow definition is not valid JSON: " + error.message);
    }
    const checked = validateFlow(definition);
    if (!checked.ok) throw new Error("flow is invalid: " + checked.violations.join("; "));

    const runRow = await store.run("flowRun.create", {
      flow_id: flowRow.id,
      input: JSON.stringify(input === undefined ? null : input),
    });
    const runId = runRow.id;
    const controller = new AbortController();
    active.set(runId, controller);

    const flow = { id: flowRow.id, definition: checked.definition };
    const emit = (event) => {
      try {
        onEvent({ ...event, runId });
      } catch (_) { /* advisory */ }
    };

    try {
      const result = await executeFlow({
        definition: checked.definition,
        input: input === undefined ? null : input,
        ctx: nodeContext(flow, runId),
        onEvent: emit,
        signal: controller.signal,
      });
      for (const record of result.nodes) {
        await store.run("flowNodeRun.add", {
          run_id: runId,
          node_id: record.nodeId,
          node_type: record.nodeType,
          seq: record.seq,
          status: record.status,
          input: JSON.stringify(record.input === undefined ? null : record.input),
          output: JSON.stringify(record.output === undefined ? null : record.output),
          error: record.error,
        });
      }
      await store.run("flowRun.finish", {
        id: runId,
        status: result.status,
        output: JSON.stringify(result.output === undefined ? null : result.output),
        error: result.error || null,
      });
      onEvent({ type: "flow-run-end", runId, status: result.status, output: result.output === undefined ? null : result.output, error: result.error });
      return { runId, status: result.status, output: result.output, error: result.error };
    } catch (error) {
      const message = (error && error.message) || String(error);
      await store.run("flowRun.finish", { id: runId, status: "failed", output: null, error: message }).catch(() => {});
      onEvent({ type: "flow-run-end", runId, status: "failed", error: message });
      throw error;
    } finally {
      // The model and tool calls cannot be interrupted mid-flight; cancellation
      // lands between nodes, where the executor re-checks the signal.
      active.delete(runId);
    }
  }

  /** Cancel an in-flight run. Idempotent; unknown ids are a no-op. */
  function cancel(runId) {
    const controller = active.get(Number(runId));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  return {
    save,
    run,
    cancel,
    list: () => store.run("flow.list"),
    get: (id) => store.run("flow.get", { id }),
    remove: (id) => store.run("flow.delete", { id }),
    listRuns: (flowId) => store.run("flowRun.list", { flow_id: flowId }),
    getRun: (id) => store.run("flowRun.get", { id }),
    listNodeRuns: (runId) => store.run("flowNodeRun.list", { run_id: runId }),
    nodeTypes: describeNodeTypes,
    validate: validateFlow,
  };
}

const __exports = { createFlowService, DEFAULT_MAX_TOKENS };
export { createFlowService, DEFAULT_MAX_TOKENS };
export default __exports;
