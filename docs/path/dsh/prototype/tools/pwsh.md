# `pwsh`

## name

`pwsh`

## description

模型收到的工具说明原文：

```text
Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. Each call runs in a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\...`); read environment variables with `$env:NAME`. Managed `$env:DSH_*` variables expose current harness environment facts. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. Provide `description` before `command` in the arguments. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. Do not assign to automatic variables such as `$HOME`; variable names are case-insensitive, so `$home` is the same read-only variable. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.
```

## system-section

- 段落名：`tool:pwsh`
- 序号（section order）：`TOOL_PWSH`（1010）
- 注册位置：`packages/shell/tool-pwsh/src/index.ts:303`
- 非空条件：注册了 `pwsh` 工具即贡献

原文：

```text
Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"Get-Process\" → \"List running processes\"."
    },
    "command": {
      "type": "string",
      "description": "The PowerShell command to execute."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed."
    },
    "workdir": {
      "type": "string",
      "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
    }
  },
  "required": [
    "description",
    "command"
  ]
}
```

## result-format

与 `bash` 同一套渲染契约：正文 + `[stderr]` 段 + 行内标记，退出标记 `[exit code: <n>]` 固定在最后；后台确认、promotion 与错误改用通用卡片，不解析退出状态。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配了 PowerShell 方言的 shell 后端时注册（Web 组合在 Windows 上默认启用）。
- 后台能力与 `bash` 相同，取决于 `ctx.jobs`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 组合里有 `ctx.jobs` 且开启后台 | 参数表出现 `run_in_background` |
| `bash` 同时存在 | Web 组合在 Windows 上二选一 |
| 执行器换成 PTC | `tool:pwsh` 段落整体失效，改用 `tools:sdk` |

### 展示投影

`presentResult` 与 `bash` 同一套规则；后台确认、promotion 与错误不做退出状态解析，改用通用卡片。

## 来源

- 包：`@deepseek-ai/dsh-tool-pwsh`（`reference/deepseek-harness/packages/shell/tool-pwsh`）
