"use strict";

// send_message 控制工具（docs/subagent/subagent.md §15.1）。
// 向 subagent 树内的另一个 agent 发消息：idle 目标立刻起一轮，运行中的目标
// 进入 steer 队列在下一步收到（§17）。返回投递回执，不返回回答。
// 不能发给自己：运行时校验同树与目标存在性。

async function run(args, exec) {
  const { agent, message } = args || {};
  if (typeof exec.sendMessage !== "function") {
    return { text: "Error: agent messaging is unavailable in this context", isError: true };
  }
  await exec.sendMessage({ senderSessionId: exec.sessionId, agent, message });
  return `message delivered to agent ${agent}`;
}

module.exports = { run };
