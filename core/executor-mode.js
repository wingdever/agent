"use strict";

// Executor mode is a deployment-level choice, like DSH's native/ptc presets.
// Default stays native; setting AGENT_TOOL_EXECUTOR=ptc makes run_code the
// only directly callable tool for a turn.

const MODES = new Set(["native", "ptc"]);

function resolveExecutorMode(value) {
  const text = String(value == null ? (process.env.AGENT_TOOL_EXECUTOR || "") : value).trim().toLowerCase();
  if (!text) return "native";
  if (MODES.has(text)) return text;
  console.warn("[tools] unknown AGENT_TOOL_EXECUTOR=" + text + "; falling back to native");
  return "native";
}

function selectForExecutor(tools, toolNames, mode = "native") {
  const visible = tools.select();
  if (mode === "ptc") {
    const runCode = tools.get("run_code");
    return {
      selected: runCode ? [runCode] : [],
      nestedToolNames: visible.filter((tool) => tool.name !== "run_code").map((tool) => tool.name),
      sdkTools: visible.filter((tool) => tool.name !== "run_code"),
    };
  }
  const selected = tools.select(toolNames);
  return {
    selected,
    nestedToolNames: selected.filter((tool) => tool.name !== "run_code").map((tool) => tool.name),
    sdkTools: [],
  };
}

const __exports = { MODES, resolveExecutorMode, selectForExecutor };
export { MODES, resolveExecutorMode, selectForExecutor };
export default __exports;
