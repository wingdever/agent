# `job_output`

## name

`job_output`

## description

模型收到的工具说明原文：

```text
Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.
```

## system-section

- 段落名：`tool:jobs`
- 序号（section order）：`TOOL_JOBS`（1600）
- 注册位置：`packages/jobs/tool-jobs/src/index.ts:317`
- 非空条件：注册了 jobs 工具即贡献；三件套共用

原文：

```text
Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.
```

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
    "wait": {
      "type": "boolean",
      "description": "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false."
    },
    "timeout_ms": {
      "type": "number",
      "description": "Max wait in milliseconds with wait: true. Defaults to and is capped by configuration."
    }
  },
  "required": [
    "job_id"
  ]
}
```

## result-format

返回任务当前状态与已产生输出（stdout/stderr 尾部）；`wait: true` 时阻塞到状态变化或超时。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配 `ctx.jobs` 时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 三个 jobs 工具同时挂载 | 共用一个段落 `tool:jobs`，只贡献一次 |
| `bash` / `pwsh` 开启后台 | `job_output` 才有实际任务可读；`bash` 参数里的 `run_in_background` 与之配套 |
| `ctx.jobs` 未挂载 | jobs 三件套不注册，段落也随之消失 |

## 来源

- 包：`@deepseek-ai/dsh-tool-jobs`（`reference/deepseek-harness/packages/jobs/tool-jobs`）
