"use strict";

// fork 委派工具（docs/dev/subagent.md 第二步实现 §8.1）。
// 与 subagent 相同：立即返回 "started subagent <id>"，子 Agent 的结算由
// core/subagent-runtime.js 回灌父会话。区别只在子会话继承父的已完成历史。

async function run(args, exec) {
  const { prompt, description, cwd } = args || {};
  if (typeof exec.subagentFork !== "function") {
    return { text: "Error: subagent fork delegation is unavailable in this context", isError: true };
  }
  const { childId } = await exec.subagentFork({ prompt, description, cwd });
  return `started subagent ${childId}`;
}

module.exports = { run };
