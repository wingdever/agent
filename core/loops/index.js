"use strict";

// Loop (agent-loop) engine registry.
//
// 两种 agent-loop 引擎并存，由环境变量 AGENT_LOOP_ENGINE 选择（实现层配置，与 AGENT_TRANSPORT 一致）：
//   - "linear"    ：现有 chat() 主循环（已抽离到 core/loops/linear.js）。
//   - "node-graph"：节点化、支持 hook 的引擎（设计见 docs/agent-loop-node-graph.md，未实现）。
//
// 每个引擎模块导出一个 async runLoop(core, ctx)，签名与现有 chat() 的循环体一致：
//   core = AgentCore 实例（所有 this.xxx 方法都在这里）
//   ctx  = 归一化后的请求上下文（messages / model / onEvent / sessionId / stream /
//          autonomy / activity / references / effort / toolNames 等）

const fs = require("fs");
const path = require("path");

// 引擎目录：本文件所在目录
const LOOPS_DIR = __dirname;

// 内置默认引擎：node-graph（节点化、支持 hook 的引擎，见 docs/agent-loop-node-graph.md）。
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
    if (!ent.isDirectory()) continue;
    // 跳过非引擎目录（如 future: nodes/ builtins/）
    if (ent.name === "nodes" || ent.name === "builtins") continue;
    const modPath = path.join(LOOPS_DIR, ent.name, "index.js");
    if (fs.existsSync(modPath)) names.push(ent.name);
  }
  if (!names.includes(DEFAULT_ENGINE)) names.push(DEFAULT_ENGINE);
  return names;
}

function loadEngine(name) {
  // 默认引擎映射：linear -> ./linear.js（单文件，不强制目录）
  const candidates = [
    path.join(LOOPS_DIR, name, "index.js"),
    path.join(LOOPS_DIR, name + ".js"),
  ];
  let modPath = candidates.find((p) => fs.existsSync(p));
  if (!modPath) {
    throw new Error("loop engine not found: " + name);
  }
  const mod = require(modPath);
  if (typeof mod.runLoop !== "function") {
    throw new Error("loop engine '" + name + "' must export async runLoop(core, ctx)");
  }
  return { name, runLoop: mod.runLoop };
}

// 返回指定名称的引擎；缺省/未知回落到 default（保证向后兼容，不会因配置错误而整体失败）。
function getLoop(name) {
  const target = name || DEFAULT_ENGINE;
  try {
    return loadEngine(target);
  } catch (e) {
    if (target === DEFAULT_ENGINE) throw e;
    console.error("[loops] unknown loop engine '" + target + "', falling back to '" + DEFAULT_ENGINE + "': " + (e.message || e));
    return loadEngine(DEFAULT_ENGINE);
  }
}

module.exports = { getLoop, listEngineNames, DEFAULT_ENGINE };
