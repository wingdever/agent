"use strict";

// interrupt_agent 控制工具（docs/agents/subagent.md）。
// 调用方必须是目标的祖先；已在运行的子会话会立刻 abort 当前轮，idle/已结束的
// 目标是成功空操作。调用被接受即返回，不等目标停稳。

async function run(args, exec) {
  const { agent } = args || {};
  if (typeof exec.interruptAgent !== "function") {
    return { text: "Error: agent interruption is unavailable in this context", isError: true };
  }
  await exec.interruptAgent({ callerSessionId: exec.sessionId, agent });
  return `interrupt requested for agent ${agent}`;
}

const __exports = { run };
export { run };
export default __exports;
