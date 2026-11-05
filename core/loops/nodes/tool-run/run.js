"use strict";

// 节点 tool-run：链路上的薄透传节点。工具的实际执行已统一在 tool-approve 内完成
// （保留与 linear 一致的逐调用事件顺序，见该节点注释）。此处仅把控制权交给 plan-review，
// 维持 docs/agent-loop-node-graph.md §4.1 的 10 节点拓扑。

module.exports = async function run(input, ctx) {
  return { output: ctx.message, next: "plan-review" };
};
