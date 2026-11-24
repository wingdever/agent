"use strict";

// subagent 委派工具（docs/agents/subagent.md）。
// 立即返回 "started subagent <name>"，不等待子 Agent 结束、不返回结果；
// 子 Agent 的结算由 core/subagent-runtime.js 以一条 user 消息回灌父会话。

async function run(args, exec) {
  const { prompt, description, cwd, name } = args || {};
  if (typeof exec.subagentSpawn !== "function") {
    return { text: "Error: subagent delegation is unavailable in this context", isError: true };
  }
  const started = await exec.subagentSpawn({ prompt, description, cwd, name });
  return `started subagent ${started.name}`;
}

const __exports = { run };
export { run };
export default __exports;
