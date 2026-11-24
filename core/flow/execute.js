"use strict";

// Flow executor: the stack-and-push model (learned from n8n).
//
// A run keeps an explicit stack of pending node executions. It pops one, runs
// it, records an input/output row, then pushes the downstream nodes reachable
// from the port the node chose. A node that returns `port: null` ends its
// branch; nothing downstream is pushed. This is what makes a condition node's
// untaken port terminate instead of skipping.
//
// Two guards keep a cyclic graph finite:
//   - every node may run at most `MAX_VISITS_PER_NODE` times per run;
//   - an identical (node, input) pair repeated back-to-back is a stall and
//     fails the run immediately (n8n's "endless loop" check).
//
// The executor never touches an Agent: nodes receive a narrow `ctx` built here
// (stream a model, run a tool) and nothing else.

import { getNodeType } from "./nodes.js";

const MAX_VISITS_PER_NODE = 10000;

/**
 * Execute a validated flow definition.
 * @param {object} options
 * @param {object} options.definition validated { nodes, edges, workdir? }
 * @param {unknown} options.input the run input value
 * @param {object} options.ctx { stream, resolveTarget, tools, runTool }
 * @param {Function} [options.onEvent] receives flow-node-start / flow-node-end
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ status, output, error?, nodes: Array }>}
 */
async function executeFlow({ definition, input, ctx, onEvent = () => {}, signal }) {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  for (const edge of definition.edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  const start = definition.nodes.find((node) => node.type === "start");
  const stack = [{ nodeId: start.id, input }];
  const visits = new Map();
  const records = [];
  let lastSignature = null;
  let lastNodeId = null;
  let output;
  let seq = 0;

  while (stack.length > 0) {
    if (signal && signal.aborted) {
      return { status: "cancelled", output: null, error: "run cancelled", nodes: records };
    }
    const item = stack.pop();
    const node = nodes.get(item.nodeId);
    const type = getNodeType(node.type);
    const count = (visits.get(node.id) || 0) + 1;
    visits.set(node.id, count);
    if (count > MAX_VISITS_PER_NODE) {
      return {
        status: "failed",
        output: null,
        error: `node "${node.id}" ran ${count} times; the flow looks like an endless loop`,
        nodes: records,
      };
    }

    const signature = node.id + "|" + stableStringify(item.input);
    if (signature === lastSignature && lastNodeId === node.id) {
      return {
        status: "failed",
        output: null,
        error: `node "${node.id}" received the same input twice in a row; the flow looks like an endless loop`,
        nodes: records,
      };
    }

    seq += 1;
    emit(onEvent, { type: "flow-node-start", nodeId: node.id, nodeType: node.type, seq, input: item.input });
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await type.run(item.input, node.data || {}, ctx);
    } catch (error) {
      const message = (error && error.message) || String(error);
      records.push({
        nodeId: node.id,
        nodeType: node.type,
        seq,
        status: "failed",
        input: item.input,
        output: null,
        error: message,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      emit(onEvent, { type: "flow-node-end", nodeId: node.id, seq, status: "failed", error: message });
      return { status: "failed", output: null, error: `node "${node.id}" failed: ${message}`, nodes: records };
    }

    records.push({
      nodeId: node.id,
      nodeType: node.type,
      seq,
      status: result.port === null ? "skipped" : "succeeded",
      input: item.input,
      output: result.output === undefined ? null : result.output,
      error: null,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    emit(onEvent, {
      type: "flow-node-end",
      nodeId: node.id,
      seq,
      status: result.port === null ? "skipped" : "succeeded",
      output: result.output === undefined ? null : result.output,
    });

    if (node.type === "end") output = item.input;
    if (result.port === null) {
      // The branch stops here: nothing downstream is pushed.
      lastSignature = signature;
      lastNodeId = node.id;
      continue;
    }

    const targets = (outgoing.get(node.id) || []).filter((edge) => edge.sourcePort === result.port);
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      stack.push({ nodeId: targets[index].target, input: result.output === undefined ? null : result.output });
    }
    lastSignature = signature;
    lastNodeId = node.id;
  }

  if (output === undefined) {
    // Every branch stopped before an end node: the graph ran but produced no
    // result, which is a property of the graph, not a normal outcome.
    return {
      status: "failed",
      output: null,
      error: "the flow produced no output: no branch reached an end node",
      nodes: records,
    };
  }
  return { status: "succeeded", output, nodes: records };
}

function emit(onEvent, event) {
  try {
    onEvent(event);
  } catch (_) {
    // A throwing observer never changes execution.
  }
}

// Key-order-independent JSON for the endless-loop comparison.
function stableStringify(value) {
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const sorted = {};
        for (const key of Object.keys(entry).sort()) sorted[key] = entry[key];
        return sorted;
      }
      return entry;
    });
  } catch (_) {
    return String(value);
  }
}

const __exports = { executeFlow, MAX_VISITS_PER_NODE, stableStringify };
export { executeFlow, MAX_VISITS_PER_NODE, stableStringify };
export default __exports;
