# `bash`

## name

`bash`

同名 `bash`，由 `@deepseek-ai/dsh-tool-bash-persistent` 提供；与一次性 `bash` 互斥（同一组合只装其一）。

## description

模型收到的工具说明原文：

```text
Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.
```

## system-section

`@deepseek-ai/dsh-tool-bash-persistent` 不注册系统提示词段落；shell 状态由 `ctx.terminals` 承载，模型通过工具返回值感知状态。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

## result-format

持久 shell 的往返输出：每次调用返回本次命令新增的 stdout/stderr，退出状态以标记形式附在末尾。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配 PTY 后端并挂载该插件时注册；与一次性 bash 工具不同时可用。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 一次性 `bash` 同时存在 | 互斥；同一组合只装其一 |
| 执行器换成 PTC | 段落整体失效；持久 shell 只能从 `run_code` 程序里调用 |

## 来源

- 包：`@deepseek-ai/dsh-tool-bash-persistent`（`reference/deepseek-harness/packages/shell/tool-bash-persistent`）
