# `todo_write`

## name

`todo_write`

## description

模型收到的工具说明原文：

```text
Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. Mark each todo `completed` as soon as it is done.
```

## system-section

不贡献系统提示词段落；todo 是 turn 内的进度投影，不写 system prompt。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "description": "The COMPLETE task list, replacing any previous list.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "content": {
            "type": "string",
            "description": "What the task is — a short imperative line."
          },
          "status": {
            "type": "string",
            "description": "pending (not started) | in_progress (now) | completed (done).",
            "enum": [
              "pending",
              "in_progress",
              "completed"
            ]
          }
        },
        "required": [
          "content",
          "status"
        ]
      }
    }
  },
  "required": [
    "todos"
  ]
}
```

## result-format

返回更新后的 todo 列表文本。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂。
- 与 Timeline 互斥：Timeline 拥有 agent 时通过工具限制隐藏 `todo_write`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| Timeline 拥有该 agent（`allowTodo: false`） | Timeline 用 `tools.restrict({ deny: ['todo_write'] })` 把 `todo_write` 从可见集合里剥掉，模型看不到它 |
| Timeline 配置 `allowTodo: true` | `todo_write` 恢复可见，Timeline 的隐藏效应解除 |
| 没有 Timeline | `todo_write` 照常可见 |

## 来源

- 包：`@deepseek-ai/dsh-tool-todo`（`reference/deepseek-harness/packages/todo/tool-todo`）
