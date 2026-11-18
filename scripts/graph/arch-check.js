"use strict";

// Architecture rule evaluation for the file-level dependency graph.
//
// Rules live in arch-rules.json as data: each rule names the files it applies
// to, the files it forbids, and per-file exceptions. Selectors may be written
// as a path glob ("core/**", "launcher.js") or as a layer name ("core",
// "ui-web"), which expands to that layer's path prefixes. This module only
// turns a rule set plus the scanned graph into a violation list; it never
// edits code.

const fs = require("fs");
const path = require("path");

const RULES_FILE = path.join(__dirname, "arch-rules.json");

// Compile a path glob with `**` (any number of segments) and `*` (one segment).
function globToRegExp(glob) {
  const body = glob
    .split("")
    .map((ch) => (ch === "*" ? "\u0000" : ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("")
    .replace(/\u0000\u0000\//g, "(?:.*/)?")
    .replace(/\u0000\u0000/g, ".*")
    .replace(/\u0000/g, "[^/]*");
  return new RegExp("^" + body + "$");
}

// A selector is either a layer name from the mapping or a path glob.
function selectorToRegExps(selector, layerMapping) {
  const byLayer = layerMapping.filter((m) => m.layer === selector);
  if (byLayer.length) {
    return byLayer.map((m) => (m.prefix.endsWith("/") ? globToRegExp(m.prefix + "**") : globToRegExp(m.prefix)));
  }
  return [globToRegExp(selector)];
}

function compileSelectors(selectors, layerMapping) {
  return (selectors || []).flatMap((s) => selectorToRegExps(s, layerMapping));
}

function matchesAny(regExps, id) {
  return regExps.some((re) => re.test(id));
}

function readArchRules() {
  return JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));
}

// Assign a layer to a file path, first matching prefix wins.
function layerFor(layerMapping, id) {
  for (const { layer, prefix } of layerMapping) {
    if (prefix.endsWith("/") ? id.startsWith(prefix) : id === prefix) return layer;
  }
  return "other";
}

// Evaluate every rule against the graph.
// Returns { violations, cycles, summary }.
function evaluateRules(graph, rulesDoc) {
  const layerMapping = (rulesDoc.layers && rulesDoc.layers.mapping) || [];
  const rules = rulesDoc.rules || [];
  const layerOf = (id) => layerFor(layerMapping, id);

  const violations = [];
  for (const rule of rules) {
    const fromRes = compileSelectors(rule.from, layerMapping);
    const denyRes = compileSelectors(rule.deny, layerMapping);
    const allowFiles = rule.allow || [];
    for (const edge of graph.edges) {
      if (!matchesAny(fromRes, edge.from)) continue;
      if (!matchesAny(denyRes, edge.to)) continue;
      if (allowFiles.includes(edge.from)) continue;
      violations.push({
        rule: rule.id,
        severity: rule.severity || "error",
        description: rule.description,
        from: edge.from,
        to: edge.to,
        fromLayer: layerOf(edge.from),
        toLayer: layerOf(edge.to),
        kind: edge.kind,
        reason: edge.kind === "dynamic" ? "runtime rule " + (edge.rule || "") : edge.kind,
        candidate: (rule.candidateFacilities || []).includes(edge.to) || undefined,
      });
    }
  }

  const cycles = findCycles(graph.nodes.map((n) => n.id), graph.edges, rulesDoc.cycles);
  const summary = {
    error: violations.filter((v) => v.severity === "error").length,
    warn: violations.filter((v) => v.severity === "warn").length + cycles.length,
    cycles: cycles.length,
    rules: rules.length,
  };
  return { violations: violations.sort(sortViolations), cycles, summary };
}

function sortViolations(a, b) {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
}

// Strongly connected components (Tarjan) over static edges only: runtime
// rules describe slot loading, not a source-level cycle.
function findCycles(nodeIds, edges, cycleCfg) {
  const adj = new Map(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (e.kind === "dynamic") continue;
    if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to);
  }
  const ignore = (cycleCfg && cycleCfg.ignore) || [];

  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  }

  for (const id of nodeIds) if (!indices.has(id)) strongConnect(id);

  return sccs
    .filter((comp) => {
      const members = new Set(comp);
      return !ignore.some((pair) => pair.length >= comp.length && pair.every((p) => members.has(p)));
    })
    .map((members) => ({
      rule: "no-static-cycles",
      severity: (cycleCfg && cycleCfg.severity) || "warn",
      members,
      description: "Static dependency cycle; review whether the modules should be split or the cycle is intentional.",
    }));
}

module.exports = { readArchRules, evaluateRules, globToRegExp, layerFor };
