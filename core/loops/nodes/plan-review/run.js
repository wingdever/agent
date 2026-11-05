"use strict";

// 节点 plan-review：链路上的薄透传节点。
//
// 说明：linear 中 exit_plan_mode 触发的计划审批是由 plan-mode 工具在执行期间通过
// core.requestPlanReview 回调挂起等待用户批准的（非独立顺序阶段）。因此本节点不单独
// 处理审批，只把控制流转给 decide-next，维持文档拓扑。实际的 plan 审批已在
// tool-approve 执行工具时按需触发。

module.exports = async function run(input, ctx) {
  return { output: ctx.message, next: "decide-next" };
};
