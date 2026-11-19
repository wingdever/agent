# `update_goal`

## name

`update_goal`

## description

模型收到的工具说明原文：

```text
Update the current goal.
```

## system-section

本段落与同组工具共用，由同一个注册点提供：

- 段落名：`tool:goal`
- 序号（section order）：`TOOL_GOAL`（2400）
- 注册位置：`packages/goal/tool-goal/src/index.ts:189`
- 非空条件、原文与变体：同组工具共用同一段文本，逐字模板见 [`create_goal`](create_goal.md) 的 system-section；文本本身不再在本页重复。


## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "goal_id": {
      "type": "string",
      "description": "Exact id returned by get_goal."
    },
    "revision": {
      "type": "number",
      "description": "Exact positive revision returned by get_goal."
    },
    "action": {
      "type": "string",
      "description": "edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.",
      "enum": [
        "edit",
        "pause",
        "resume",
        "complete",
        "blocked"
      ]
    },
    "objective": {
      "type": "string",
      "description": "Replacement objective; valid only with action edit."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Replacement cap; valid only with action edit."
    },
    "blocked_reason": {
      "type": "string",
      "description": "Required only with action blocked: the concrete condition that persisted across rounds and blocks progress."
    }
  },
  "required": [
    "goal_id",
    "revision",
    "action"
  ]
}
```

## result-format

返回更新后的目标状态或冲突错误（revision 不匹配）。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 与 `create_goal` 同组合挂载；complete / blocked 额外接受目标轮次身份。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 三个 goal 工具同时挂载 | 共用一个段落 `tool:goal` |
| `blockedAfterConsecutiveRounds` 改动 | 段落里的轮次数字随之改变 |

## 来源

- 包：`@deepseek-ai/dsh-tool-goal`（`reference/deepseek-harness/packages/goal/tool-goal`）
