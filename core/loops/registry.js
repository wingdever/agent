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

import fs from "fs";
import path from "path";
import { fileURLToPath as __fileURLToPath, pathToFileURL } from "node:url";
import { dirname as __pathDirname } from "node:path";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));


const NODES_DIR = path.join(__dirname, "nodes");
const BUILTINS_DIR = path.join(__dirname, "builtins");

async function loadFromDir(dir, typeOverride) {
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
        run = await import(pathToFileURL(runPath).href);
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
async function loadNodesAsync() {
  const all = [...(await loadFromDir(NODES_DIR)), ...(await loadFromDir(BUILTINS_DIR, "builtin"))];
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

// 扫描目录必须用动态 import（异步），但调用方（node-graph 构造器、catalog RPC）依赖同步 API。
// 因此用顶层 await 在模块初始化时一次性建好缓存，对外保持同步签名不变。
let __nodesCache = null;

function loadNodes() {
  if (!__nodesCache) {
    throw new Error("[loops] node registry not initialized yet");
  }
  return __nodesCache;
}

__nodesCache = await loadNodesAsync();

const __exports = { loadNodes, loadNodesAsync, NODES_DIR, BUILTINS_DIR };
export { loadNodes, loadNodesAsync, NODES_DIR, BUILTINS_DIR };
export default __exports;
