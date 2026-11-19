# `bash`

## name

`bash`

## description

模型收到的工具说明原文：

```text
Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell; pass `workdir` instead of using `cd`. Managed `$DSH_*` variables expose current harness environment facts. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Provide `description` before `command` in the arguments. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.
```

## system-section

- 段落名：`tool:bash`
- 序号（section order）：`TOOL_BASH`（1000）
- 注册位置：`packages/shell/tool-bash/src/index.ts:291`
- 非空条件：注册了 `bash` 工具即贡献；段落与被选中的执行器无关

原文：

```text
Check the [exit code: N] marker on every bash result; investigate failures before moving on.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"npm install\" → \"Install package dependencies\"."
    },
    "command": {
      "type": "string",
      "description": "The bash command to execute."
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

工具返回规范化结构（stdout、stderr、退出码、信号、超时、沙箱状态等）；模型看到的是渲染后的文本：stdout 正文，stderr 非空时以 `[stderr]` 分隔附后，空输出为 `(no output)`。随后按顺序追加行内标记，退出标记固定在最后：`[exit code: <n>]`、`[killed by signal: <sig>]`、`[timed out after <ms>ms]`、`[stopped: <reason>]`、沙箱拒绝标记。前台调用等待超时会被转成后台任务，文本末尾追加 `[still running after <ms>ms; moved to background job <id>]`。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂；Web 组合在 Windows 上由 `pwsh` 替换。
- 组合里存在 `ctx.jobs` 且开启后台时提供 `run_in_background`；否则为前台专用 schema。
- `sandbox_permissions` / `justification` 只在配有沙箱执行器时出现在参数表里。
- 超时预算由 `tool-call-timeout-policy` 执行，不发往模型。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 组合里有 `ctx.jobs` 且 `enableRunInBackground` 为真 | 参数表出现 `run_in_background`；前台等待超时会被转成后台任务，结果尾追加 `[still running after <ms>ms; moved to background job <id>]` |
| 没有 `ctx.jobs` 或 `enableRunInBackground: false` | 参数表没有 `run_in_background`，只保留前台调用 |
| 组合配有沙箱执行器 | 参数表出现 `sandbox_permissions` / `justification`；结果可能出现沙箱拒绝标记 |
| `pwsh` 同时存在 | Web 组合在 Windows 上二选一，同一个组合不会同时挂 `bash` 与 `pwsh` |
| `bash-persistent` 已挂载 | 与一次性 `bash` 互斥，同一组合只装其一 |
| 执行器换成 PTC | `tool:bash` 段落整体失效；`bash` 只能从 `run_code` 程序里调 |

### 展示投影

`presentResult` 依据持久化的流片段重建命令卡片，并把退出标记从正文里摘出来做成卡片的 exit pill。

## 来源

- 包：`@deepseek-ai/dsh-tool-bash`（`reference/deepseek-harness/packages/shell/tool-bash`）
