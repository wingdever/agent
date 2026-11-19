"use strict";

// list_agents 控制工具（docs/agents/subagent.md）。
// 列出整棵 subagent 树：根 + 所有可达的可续后代，含调用方自己；每行
// `<name> [<status>] — <description>`，根行固定为 `lead […] — root agent`。

async function run(args, exec) {
  if (typeof exec.listAgents !== "function") {
    return { text: "Error: agent listing is unavailable in this context", isError: true };
  }
  const rows = await exec.listAgents({ callerSessionId: exec.sessionId });
  const lines = rows.map((r) => {
    const description = r.name === "lead" ? "root agent" : r.description;
    return `${r.name} [${r.status}] — ${description}`;
  });
  return lines.join("\n");
}

module.exports = { run };
