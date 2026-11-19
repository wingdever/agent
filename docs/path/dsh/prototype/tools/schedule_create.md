# `schedule_create`

## name

`schedule_create`

## description

模型收到的工具说明原文：

```text
Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target session as a scheduled message from the user. The result includes the task id and the next occurrence as scheduledAt in UTC and scheduledAtLocal in the zone of rrule. After downtime, only the latest missed occurrence is delivered. Delivery can repeat after a crash.
```

## system-section

- 段落名：`tool:schedule`
- 序号（section order）：`TOOL_SCHEDULE`（2500）
- 注册位置：`packages/schedule/tool-schedule/src/index.ts:366`
- 非空条件：可见 `schedule_create` 或 `schedule_edit` 时非空

原文：

```text
Only create or modify scheduled tasks at the user's explicit request; prior explicit user authorization for the running scheduled task remains valid.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "Task name of at most 120 characters in the user's language: action plus object. Omit timing, status, ids, and bracketed suffixes."
    },
    "prompt": {
      "type": "string",
      "description": "Instruction delivered at each occurrence."
    },
    "rrule": {
      "type": "string",
      "description": "Supported RFC 5545 subset: one DTSTART line, a newline, and one RRULE line. DTSTART ends in Z for UTC or carries TZID with an IANA time zone; a fixed offset such as UTC+5 is Etc/GMT-5, with the sign reversed. DTSTART must name an existing local time. A TZID rule keeps local clock time across daylight-saving changes; generated nonexistent local times are skipped, and repeated ones occur once, at the earlier instant. DTSTART may be in the past; delivery starts with the first occurrence after creation. A one-time delivery is RRULE:FREQ=DAILY;COUNT=1. No SECONDLY; BYSECOND takes one value. COUNT is at most 1000; use UNTIL for longer rules. MINUTELY and HOURLY accept no BY parts, so select clock times with DAILY or WEEKLY plus BYHOUR and BYMINUTE. BYMONTHDAY and ordinal BYDAY require MONTHLY or YEARLY; BYYEARDAY and BYWEEKNO require YEARLY. Ordinal BYDAY cannot combine with BYWEEKNO. Each FREQ period allows at most 10080 candidates before BYSETPOS, which accepts at most 31 values. UNTIL is a UTC instant ending in Z. Example: \"DTSTART;TZID=Asia/Singapore:20260901T080000\\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1\""
    },
    "target": {
      "type": "string",
      "description": "this_session delivers to this session; new_once delivers to the same new session every time, opened at the first delivery; new opens a different new session for every delivery. New sessions use this session's working directory and preset. With this_session or new_once, a delivery waits until the previous one finishes, and only the latest occurrence that passed meanwhile is delivered. Use this_session for reminders and for follow-ups to this conversation; use new_once or new for independent work, such as a recurring report, and whenever the user asks for a new conversation.",
      "enum": [
        "this_session",
        "new_once",
        "new"
      ]
    }
  },
  "required": [
    "title",
    "prompt",
    "rrule",
    "target"
  ]
}
```

## result-format

返回任务 id 与下一次触发时间（`scheduledAt` UTC、`scheduledAtLocal` 按 rrule 时区）。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配 `ctx.schedule` 且预设/agent 作用域挂载该插件时注册；委派子代理不可调用。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `schedule_edit` 可见 | 段落出现 `Only create or modify scheduled tasks ...` |
| 两个工具都不可见 | 段落为空 |
| 委派子代理 | 四个 schedule 工具都不对子代理披露 |

## 来源

- 包：`@deepseek-ai/dsh-tool-schedule`（`reference/deepseek-harness/packages/schedule/tool-schedule`）
