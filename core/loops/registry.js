"use strict";

// Node 注册表加载器（仿 tools/registry.js 的目录化注册）。
//
// 每个节点一个目录 core/loops/nodes/<node-id>/，含：
//   registry.json  : { id, next, type: "core"|"builtin", hooks:{before:[],after:[],onError:[]}, entry }
//   run.js         : module.exports = async function run(input, ctx) { return { output, next?, done? }; }
//
// builtin 节点（二级预定义，不在默认 next 链上）放在 core/loops/builtins/<node-id>/，
// 同样含 registry.json + run.js，由 loadNodes 一并载入，type 标记为 "builtin"。
//
// loadNodes() 返回 Map<nodeId, Node>，其中 Node = { ...registry 字段, run }。

const fs = require("fs");
const path = require("path");

const NODES_DIR = path.join(__dirname, "nodes");
const BUILTINS_DIR = path.join(__dirname, "builtins");

function loadFromDir(dir, typeOverride) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const nodeDir = path.join(dir, ent.name);
    const regPath = path.join(nodeDir, "registry.json");
    if (!fs.existsSync(regPath)) continue;
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(regPath, "utf8"));
    } catch (e) {
      console.error("[loops] bad registry.json in " + nodeDir + ": " + e.message);
      continue;
    }
    const entry = registry.entry || "run.js";
    const runPath = path.join(nodeDir, entry);
    let run = null;
    if (fs.existsSync(runPath)) {
      try {
        run = require(runPath);
        if (run && run.default) run = run.default;
        if (typeof run !== "function") run = null;
      } catch (e) {
        console.error("[loops] failed to load run() in " + nodeDir + ": " + e.message);
      }
    }
    const node = Object.assign({}, registry, { dir: nodeDir, entry, run });
    if (typeOverride) node.type = typeOverride;
    out.push(node);
  }
  return out;
}

// 加载全部节点（主干 + builtin）。主干 nodes/* 的 type 以 registry.json 声明为准，
// builtins/* 强制 type="builtin"。返回 Map<nodeId, Node>。
function loadNodes() {
  const all = [...loadFromDir(NODES_DIR), ...loadFromDir(BUILTINS_DIR, "builtin")];
  const map = new Map();
  for (const node of all) {
    if (!node.id) {
      console.error("[loops] node in " + (node.dir || "?") + " missing id in registry.json; skipped");
      continue;
    }
    if (typeof node.run !== "function") {
      console.error("[loops] node '" + node.id + "' has no run() function; skipped");
      continue;
    }
    map.set(node.id, node);
  }
  return map;
}

module.exports = { loadNodes, NODES_DIR, BUILTINS_DIR };
