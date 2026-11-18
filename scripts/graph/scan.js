#!/usr/bin/env node

"use strict";

// File-level dependency graph scanner.
//
// Reads the source tree, extracts static `require("./x")` / `import "./x"`
// specifiers, resolves each to an in-tree file, then overlays the runtime
// edge rules from runtime-edges.json (data-driven dynamic requires) and
// writes ui/web/graph-data.json for the graph tab to fetch.
//
// Usage: node scripts/graph/scan.js
// Re-run after changing code; the graph tab always reads the generated file.

const fs = require("fs");
const path = require("path");
const { init, parse } = require("es-module-lexer");

const ROOT = path.resolve(__dirname, "..", "..");
const RULES_FILE = path.join(__dirname, "runtime-edges.json");
const OUT_FILE = path.join(ROOT, "ui", "web", "graph-data.json");

// Scan roots relative to ROOT. Anything reachable from these is a graph node.
const SCAN_ROOTS = ["launcher.js", "core", "tools", "ui", "providers", "scripts"];

// Excluded paths (relative to ROOT, forward slashes). Generator output and
// third-party vendor bundles are not part of the project's dependency graph.
const EXCLUDE = [
  /^ui\/web\/graph-data\.json$/,
  /^ui\/web\/vendor\//,
  /^ui\/electron\/node_modules\//,
  /node_modules\//,
  /\.test\.(m?js)$/,
];

// Extensions tried when resolving an extensionless specifier, in Node order.
const RESOLVE_EXTS = [".js", ".mjs", ".cjs", ".json"];

function toRel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

function isExcluded(rel) {
  return EXCLUDE.some((re) => re.test(rel));
}

function walk(absDir, out) {
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, ent.name);
    const rel = toRel(abs);
    if (isExcluded(rel)) continue;
    if (ent.isDirectory()) walk(abs, out);
    else out.push(rel);
  }
}

function isSource(rel) {
  return /\.(m?js)$/.test(rel);
}

// Resolve a specifier written inside `fromRel` to an in-tree node path,
// following the same order as Node: bare file, then extensions, then a
// directory's package.json main / index file. Returns null for external
// packages ("electron", "path", ...) and paths outside the graph.
function resolveSpecifier(fromRel, specifier) {
  if (!specifier.startsWith(".")) return null;
  const baseAbs = path.resolve(path.dirname(path.join(ROOT, fromRel)), specifier);
  const candidates = [];
  for (const ext of ["", ...RESOLVE_EXTS]) candidates.push(baseAbs + ext);
  if (fs.existsSync(baseAbs) && fs.statSync(baseAbs).isDirectory()) {
    const pkgPath = path.join(baseAbs, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const main = JSON.parse(fs.readFileSync(pkgPath, "utf8")).main;
        if (typeof main === "string" && main) {
          for (const ext of ["", ...RESOLVE_EXTS]) candidates.push(path.resolve(baseAbs, main + ext));
        }
      } catch (_) { /* ignore malformed package.json */ }
    }
    for (const ext of RESOLVE_EXTS) candidates.push(path.join(baseAbs, "index" + ext));
  }
  for (const candidateAbs of candidates) {
    if (!fs.existsSync(candidateAbs) || !fs.statSync(candidateAbs).isFile()) continue;
    if (!isSource(candidateAbs)) return null;
    const rel = toRel(candidateAbs);
    return isExcluded(rel) ? null : rel;
  }
  return null;
}

// Strip whole-line comments so documentation samples such as a quoted
// specifier in a `//` comment do not become graph edges.
function stripCommentLines(code) {
  return code
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") ? "" : line;
    })
    .join("\n");
}

// Extract literal specifiers. es-module-lexer handles static import and
// dynamic import(); CommonJS require() is not covered by it, so a targeted
// regex handles a single-quoted or double-quoted string argument, which is
// the form this codebase uses.
function extractSpecifiers(rawCode) {
  const code = stripCommentLines(rawCode);
  const specs = [];
  const [imports] = parse(code);
  for (const imp of imports) {
    if (typeof imp.specifier === "string") specs.push({ specifier: imp.specifier, kind: "import" });
  }
  const re = /(?:^|[^\w$.])require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(code))) specs.push({ specifier: m[2], kind: "require" });
  return specs;
}

function matchRuntimeRules(files) {
  const rules = JSON.parse(fs.readFileSync(RULES_FILE, "utf8")).rules || [];
  const edges = [];
  for (const rule of rules) {
    if (!files.includes(rule.from)) continue;
    for (const target of rule.targets || []) {
      const matched = expandTarget(target, files);
      for (const to of matched) {
        edges.push({ from: rule.from, to, kind: rule.kind || "dynamic", rule: rule.id, code: rule.code, reason: rule.reason });
      }
    }
  }
  return edges;
}

// Expand a rule target: a plain path matches itself; a glob with one `*`
// directory segment matches every node below the fixed prefix/suffix.
function expandTarget(target, files) {
  if (!target.includes("*")) return files.includes(target) ? [target] : [];
  const [prefix, suffix] = target.split("*");
  return files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix) && !f.slice(prefix.length, f.length - suffix.length).includes("/"));
}

function layerOf(rel) {
  if (rel === "launcher.js") return "entry";
  if (rel.startsWith("core/")) return "core";
  if (rel.startsWith("tools/")) return "tools";
  if (rel.startsWith("ui/electron/")) return "ui-electron";
  if (rel.startsWith("ui/web/")) return "ui-web";
  if (rel.startsWith("providers/")) return "providers";
  if (rel.startsWith("scripts/")) return "scripts";
  return "other";
}

function subdirOf(rel) {
  const parts = rel.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

async function main() {
  await init();

  const files = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(ROOT, root);
    if (!fs.existsSync(abs) || isExcluded(toRel(abs))) continue;
    if (fs.statSync(abs).isDirectory()) walk(abs, files);
    else files.push(toRel(abs));
  }
  const sources = files.filter(isSource).sort();

  const nodes = new Map();
  const edges = [];
  const missing = [];

  for (const rel of sources) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const node = {
      id: rel,
      layer: layerOf(rel),
      subdir: subdirOf(rel),
      lines: code.split("\n").length,
    };
    for (const { specifier, kind } of extractSpecifiers(code)) {
      const to = resolveSpecifier(rel, specifier);
      if (to) edges.push({ from: rel, to, kind, specifier });
      else if (specifier.startsWith(".")) missing.push({ from: rel, specifier });
    }
    nodes.set(rel, node);
  }

  const seen = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
  for (const e of matchRuntimeRules(sources)) {
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }
  // Drop self-edges and edges whose target did not survive filtering.
  const finalEdges = edges.filter((e) => e.from !== e.to && nodes.has(e.from) && nodes.has(e.to));

  const payload = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    nodes: [...nodes.values()],
    edges: finalEdges,
    unresolved: missing,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");

  const byKind = {};
  for (const e of finalEdges) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  console.log(`[graph] nodes=${nodes.size} edges=${finalEdges.length} ${JSON.stringify(byKind)} unresolved=${missing.length}`);
  for (const m of missing) console.warn(`[graph] unresolved relative require in ${m.from}: ${m.specifier}`);
  console.log(`[graph] wrote ${toRel(OUT_FILE)}`);
}

main().catch((e) => {
  console.error("[graph] scan failed:", e);
  process.exit(1);
});
