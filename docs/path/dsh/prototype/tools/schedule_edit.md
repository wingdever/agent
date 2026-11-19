# `schedule_edit`

## name

`schedule_edit`

## description

模型收到的工具说明原文：

```text
Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.
```

## system-section

本段落与同组工具共用，由同一个注册点提供：

- 段落名：`tool:schedule`
- 序号（section order）：`TOOL_SCHEDULE`（2500）
- 注册位置：`packages/schedule/tool-schedule/src/index.ts:366`
- 非空条件、原文与变体：同组工具共用同一段文本，逐字模板见 [`schedule_create`](schedule_create.md) 的 system-section；文本本身不再在本页重复。


## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Task id."
    },
    "action": {
      "type": "string",
      "description": "update applies the provided fields, at least one; delete removes the task.",
      "enum": [
        "update",
        "delete"
      ]
    },
    "title": {
      "type": "string",
      "description": "Task name of at most 120 characters in the user's language: action plus object. Omit timing, status, ids, and bracketed suffixes."
    },
    "prompt": {
      "type": "string",
      "description": "New instruction delivered at each occurrence."
    },
    "rrule": {
      "type": "string",
      "description": "New recurrence in the schedule_create rrule format."
    },
    "target": {
      "type": "string",
      "description": "Omit to retain the destination and its creation settings. Providing target replaces them; new_once reserves a different Session. New targets capture this Session's working directory and preset. Choices are the same as schedule_create.",
      "enum": [
        "this_session",
        "new_once",
        "new"
      ]
    },
    "active": {
      "type": "boolean",
      "description": "false pauses the task; true resumes only if its timing has a future occurrence. Otherwise provide a new rrule."
    },
    "expectedUpdatedAt": {
      "type": "string",
      "description": "updatedAt from the latest result that returned this task; if the task changed after that result, the result is schedule_conflict and nothing changes."
    }
  },
  "required": [
    "id",
    "action"
  ]
}
```

## result-format

返回任务定义、下一次触发时间或任务列表。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 同 `schedule_create`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `schedule_create` 或 `schedule_edit` 任一可见 | 共用段落出现 |
| 两者都不可见 | 段落为空 |

## 来源

- 包：`@deepseek-ai/dsh-tool-schedule`（`reference/deepseek-harness/packages/schedule/tool-schedule`）
