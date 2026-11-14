"use strict";

// one-shot subagent 委派工具（docs/dev/subagent.md §2.1）。
// 立即返回 "started subagent <id>"，不等待子 Agent 结束、不返回结果；
// 子 Agent 的结算由 core/subagent-runtime.js 以一条 user 消息回灌父会话。

async function run(args, exec) {
  const { prompt, description, cwd } = args || {};
  if (typeof exec.subagentSpawn !== "function") {
    return { text: "Error: subagent delegation is unavailable in this context", isError: true };
  }
  const { childId } = await exec.subagentSpawn({ prompt, description, cwd });
  return `started subagent ${childId}`;
}

module.exports = { run };
