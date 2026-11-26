"use strict";

// Loop (agent-loop) engine registry.
//
// 两种 agent-loop 引擎并存，由环境变量 AGENT_LOOP_ENGINE 选择（实现层配置，与 AGENT_TRANSPORT 一致）：
//   - "node-graph"：节点化、支持 hook 的正式引擎。
//   - "linear"    ：冻结对照基线；不补新功能，也不要求与 node-graph parity。
//
// 每个引擎模块导出一个 async runLoop(core, ctx)，签名与现有 chat() 的循环体一致：
//   core = createCore 返回的服务集合
//   ctx  = 归一化后的请求上下文（messages / model / onEvent / sessionId / stream /
//          autonomy / activity / references / effort / toolNames 等）

import fs from "fs";
import path from "path";
import { fileURLToPath as __fileURLToPath, pathToFileURL } from "node:url";
import { dirname as __pathDirname } from "node:path";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));


// 引擎目录：本文件所在目录
const LOOPS_DIR = __dirname;

// 内置默认引擎：node-graph（节点化、支持 hook 的引擎，见 docs/runtime/node-graph.md）。
// 不设 AGENT_LOOP_ENGINE 时即走此引擎。
const DEFAULT_ENGINE = "node-graph";

// 已加载引擎缓存：Map<name, { runLoop }>
const engines = null; // 懒加载，见 getLoop

function listEngineNames() {
  let entries;
  try {
    entries = fs.readdirSync(LOOPS_DIR, { withFileTypes: true });
  } catch (_) {
    return [DEFAULT_ENGINE];
  }
  const names = [];
  for (const ent of entries) {
    if (ent.isDirectory()) {
      // 跳过非引擎目录（nodes/ builtins/）
      if (ent.name === "nodes" || ent.name === "builtins") continue;
      if (fs.existsSync(path.join(LOOPS_DIR, ent.name, "index.js"))) names.push(ent.name);
      continue;
    }
    // 文件型引擎（linear.js）：单文件引擎也要被发现。
    if (!ent.name.endsWith(".js") || ent.name === "index.js") continue;
    const name = ent.name.slice(0, -3);
    if (name === "registry" || name === "shared" || name === "loops-config") continue;
    names.push(name);
  }
  if (!names.includes(DEFAULT_ENGINE)) names.push(DEFAULT_ENGINE);
  return names;
}

async function loadEngine(name) {
  // 默认引擎映射：linear -> ./linear.js（单文件，不强制目录）
  const candidates = [
    path.join(LOOPS_DIR, name, "index.js"),
    path.join(LOOPS_DIR, name + ".js"),
  ];
  const modPath = candidates.find((p) => fs.existsSync(p));
  if (!modPath) {
    throw new Error("loop engine not found: " + name);
  }
  // ESM 只有动态 import 能按路径加载；统一取 default 与命名空间里的 runLoop
  const ns = await import(pathToFileURL(modPath).href);
  const mod = ns.default && typeof ns.default.runLoop === "function" ? ns.default : ns;
  if (typeof mod.runLoop !== "function") {
    throw new Error("loop engine '" + name + "' must export async runLoop(core, ctx)");
  }
  // `resumeLoop` is optional: an engine that cannot continue a paused turn
  // simply does not export it, and the runtime reports that.
  const engine = { name, runLoop: mod.runLoop };
  if (typeof mod.resumeLoop === "function") engine.resumeLoop = mod.resumeLoop;
  return engine;
}

// 返回指定名称的引擎；缺省/未知回落到 default（保证向后兼容，不会因配置错误而整体失败）。
async function getLoop(name) {
  const target = name || DEFAULT_ENGINE;
  try {
    return await loadEngine(target);
  } catch (e) {
    if (target === DEFAULT_ENGINE) throw e;
    console.error("[loops] unknown loop engine '" + target + "', falling back to '" + DEFAULT_ENGINE + "': " + (e.message || e));
    return loadEngine(DEFAULT_ENGINE);
  }
}

const __exports = { getLoop, listEngineNames, DEFAULT_ENGINE };
export { getLoop, listEngineNames, DEFAULT_ENGINE };
export default __exports;
