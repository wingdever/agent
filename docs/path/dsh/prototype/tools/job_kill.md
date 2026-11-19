# `job_kill`

## name

`job_kill`

## description

模型收到的工具说明原文：

```text
Request cancellation of a running background job.
```

## system-section

本段落与同组工具共用，由同一个注册点提供：

- 段落名：`tool:jobs`
- 序号（section order）：`TOOL_JOBS`（1600）
- 注册位置：`packages/jobs/tool-jobs/src/index.ts:317`
- 非空条件、原文与变体：同组工具共用同一段文本，逐字模板见 [`job_output`](job_output.md) 的 system-section；文本本身不再在本页重复。


## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "description": "Job id returned by the tool that started the background work."
    },
    "reason": {
      "type": "string",
      "description": "Optional short reason, recorded in the log and forwarded to the job."
    }
  },
  "required": [
    "job_id"
  ]
}
```

## result-format

返回取消结果；已完成或不存在的任务明示。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配 `ctx.jobs` 时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 三个 jobs 工具同时挂载 | 共用一个段落 `tool:jobs` |
| `ctx.jobs` 未挂载 | jobs 三件套不注册 |

## 来源

- 包：`@deepseek-ai/dsh-tool-jobs`（`reference/deepseek-harness/packages/jobs/tool-jobs`）
