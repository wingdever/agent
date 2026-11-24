"use strict";

// Flow definition validation.
//
// A graph that passes here is runnable: every edge names real ports on real
// nodes, every node type exists, exactly one start node exists, and no edge
// points into a start node or out of an end node. Validation returns every
// violation at once so the canvas can show them all instead of one per save.
//
// Cycles are NOT rejected: they are how a graph loops, and the executor's
// (node, visit-count) guard is what stops a runaway one.

import { getNodeType } from "./nodes.js";

const REACHABLE_GUARD = 10000;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a flow definition.
 * @param {unknown} definition { nodes, edges, workdir? }
 * @returns {{ ok: boolean, violations: string[], definition?: object }}
 */
function validateFlow(definition) {
  const violations = [];
  if (!isObject(definition)) return { ok: false, violations: ["definition must be an object"] };
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition.edges) ? definition.edges : [];
  if (!Array.isArray(definition.nodes)) violations.push("definition.nodes must be an array");
  if (!Array.isArray(definition.edges)) violations.push("definition.edges must be an array");
  if (definition.workdir !== undefined && typeof definition.workdir !== "string") {
    violations.push("definition.workdir must be a string");
  }

  const byId = new Map();
  nodes.forEach((node, index) => {
    const where = `nodes[${index}]`;
    if (!isObject(node)) {
      violations.push(`${where} must be an object`);
      return;
    }
    if (typeof node.id !== "string" || !node.id.trim()) violations.push(`${where}.id must be a non-empty string`);
    else if (byId.has(node.id)) violations.push(`${where}.id "${node.id}" is duplicated`);
    const type = getNodeType(node.type);
    if (!type) violations.push(`${where}.type "${String(node.type)}" is not a known node type`);
    if (node.data !== undefined && !isObject(node.data)) violations.push(`${where}.data must be an object`);
    if (isObject(node.position)) {
      if (typeof node.position.x !== "number" || typeof node.position.y !== "number") {
        violations.push(`${where}.position must carry numeric x and y`);
      }
    } else if (node.position !== undefined) {
      violations.push(`${where}.position must be an object`);
    }
    if (type && typeof node.id === "string") byId.set(node.id, { node, type });
  });

  const starts = nodes.filter((node) => isObject(node) && node.type === "start");
  if (starts.length === 0) violations.push("the flow needs exactly one start node");
  if (starts.length > 1) violations.push(`the flow needs exactly one start node, found ${starts.length}`);

  // A run's value is whatever reaches an end node; a graph without one can
  // execute but never produce a result, so it is rejected up front instead of
  // failing ambiguously at run time.
  const ends = nodes.filter((node) => isObject(node) && node.type === "end");
  if (ends.length === 0) violations.push("the flow needs at least one end node");

  edges.forEach((edge, index) => {
    const where = `edges[${index}]`;
    if (!isObject(edge)) {
      violations.push(`${where} must be an object`);
      return;
    }
    if (typeof edge.id !== "string" || !edge.id.trim()) violations.push(`${where}.id must be a non-empty string`);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source) violations.push(`${where}.source "${String(edge.source)}" is not a node in this flow`);
    if (!target) violations.push(`${where}.target "${String(edge.target)}" is not a node in this flow`);
    if (source) {
      if (source.type.outputs.length === 0) {
        violations.push(`${where} leaves "${edge.source}", which has no output port`);
      } else if (!source.type.outputs.includes(edge.sourcePort)) {
        violations.push(
          `${where}.sourcePort "${String(edge.sourcePort)}" is not an output of ${source.node.type} (${source.type.outputs.join(", ")})`,
        );
      }
    }
    if (target) {
      if (target.type.inputs.length === 0) {
        violations.push(`${where} enters "${edge.target}", which has no input port`);
      } else if (!target.type.inputs.includes(edge.targetPort)) {
        violations.push(
          `${where}.targetPort "${String(edge.targetPort)}" is not an input of ${target.node.type} (${target.type.inputs.join(", ")})`,
        );
      }
    }
  });

  if (violations.length > 0) return { ok: false, violations };

  const normalizedNodes = nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: isObject(node.position) ? { x: node.position.x, y: node.position.y } : { x: 0, y: 0 },
    data: isObject(node.data) ? node.data : {},
  }));
  const normalizedEdges = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourcePort: edge.sourcePort,
    target: edge.target,
    targetPort: edge.targetPort,
    ...(isObject(edge.data) ? { data: edge.data } : {}),
  }));
  const normalized = { nodes: normalizedNodes, edges: normalizedEdges };
  if (typeof definition.workdir === "string" && definition.workdir.trim()) normalized.workdir = definition.workdir;

  const reachable = reachableFrom(normalized, starts[0].id);
  for (const node of normalizedNodes) {
    if (node.type !== "start" && !reachable.has(node.id)) {
      violations.push(`node "${node.id}" is unreachable from the start node`);
    }
  }
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, violations: [], definition: normalized };
}

/** Node ids reachable from `startId` along edges, in a bounded walk. */
function reachableFrom(definition, startId) {
  const seen = new Set();
  const outgoing = new Map();
  for (const edge of definition.edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  const queue = [startId];
  while (queue.length && seen.size < REACHABLE_GUARD) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of outgoing.get(id) || []) {
      if (!seen.has(edge.target)) queue.push(edge.target);
    }
  }
  return seen;
}

const __exports = { validateFlow, reachableFrom };
export { validateFlow, reachableFrom };
export default __exports;
