# `propose_action`

## name

`propose_action`

## description

模型收到的工具说明原文：

```text
Show the user one optional action card under this answer. Call only as the skill that names the action instructs.
```

## system-section

不贡献系统提示词段落；只允许在该技能的指令内调用。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "Action name from the skill."
    },
    "title": {
      "type": "string",
      "description": "Card title."
    },
    "brief": {
      "type": "string",
      "description": "What the action does, in the user's language."
    },
    "details": {
      "type": "object",
      "description": "Fields the skill lists for this action.",
      "additionalProperties": true
    }
  },
  "required": [
    "action",
    "title",
    "brief",
    "details"
  ]
}
```

## result-format

返回卡片提议记录；`propose_action` 调用与用户决定写入会话记录。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 仅对加载了已注册卡片类型技能的 agent 声明。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 加载了已注册卡片类型的技能 | 工具披露 |
| 未加载相关技能 | 不披露 |

## 来源

- 包：`@deepseek-ai/dsh-action-cards`（`reference/deepseek-harness/packages/experimental/action-cards`）
