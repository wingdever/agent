# `exit_plan_mode`

## name

`exit_plan_mode`

## description

模型收到的工具说明原文：

```text
Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again.
```

## system-section

- 段落名：`plan:policy`
- 序号（section order）：`PLAN_POLICY`（500）
- 注册位置：`packages/plan/plan-mode/src/index.ts:199`
- 非空条件：会话的计划态处于 active 时

原文：

```text
会话处于计划态时该段落整体非空（原文即 plan-mode 的 `section` 配置，见 communicate-contract.md 3.10）；`exit_plan_mode` 的 progressive disclosure 规则写在段落里。
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "plan": {
      "type": "string",
      "description": "The complete plan, as markdown, starting with a # heading that names it."
    }
  },
  "required": [
    "plan"
  ]
}
```

## result-format

提交计划后返回用户决定：批准则计划态在该步边界变为 inactive；拒绝则带回反馈供下一轮重写。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 计划态首次生效的 step 起被披露，并在该会话余下时间里保持可见；非计划态调用会被拒绝。
- 工具目录跨模式保持一致，以便请求缓存稳定。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 计划态 active | `plan:policy` 段落出现，工具披露且可调 |
| 计划态 inactive | 工具仍在声明里（保持目录稳定），但调用会被拒绝 |
| 执行器换成 PTC | `plan:policy` 段落失效；工具只能从 `run_code` 程序里调用 |

## 来源

- 包：`@deepseek-ai/dsh-plan-mode`（`reference/deepseek-harness/packages/plan/plan-mode`）
