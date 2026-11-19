# `schedule_list`

## name

`schedule_list`

## description

模型收到的工具说明原文：

```text
List scheduled tasks, including tasks created from other sessions. Active tasks come first, ordered by scheduledAt.
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
    "active": {
      "type": "boolean",
      "description": "true for active tasks only; false for paused and ended tasks only; omitted for all tasks."
    },
    "limit": {
      "type": "integer",
      "description": "Page size from 1 to 500; defaults to 100."
    },
    "offset": {
      "type": "integer",
      "description": "Number of tasks to skip; defaults to 0."
    }
  }
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
