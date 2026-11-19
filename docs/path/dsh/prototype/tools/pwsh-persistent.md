# `pwsh`

## name

`pwsh`

同名 `pwsh`，由 `@deepseek-ai/dsh-tool-pwsh-persistent` 提供；持久 PowerShell 会话。

## description

模型收到的工具说明原文：

```text
Run commands in a persistent PowerShell shell. State, including the current directory and exported environment variables, persists across calls for this agent.
```

## system-section

`@deepseek-ai/dsh-tool-pwsh-persistent` 不注册系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

## result-format

持久 PowerShell 会话的增量输出，形态与 `pwsh` 一致。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配 pwsh 方言 PTY 后端并挂载该插件时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 一次性 `pwsh` 同时存在 | 互斥；同一组合只装其一 |
| 执行器换成 PTC | 段落整体失效；持久 shell 只能从 `run_code` 程序里调用 |

## 来源

- 包：`@deepseek-ai/dsh-tool-pwsh-persistent`（`reference/deepseek-harness/packages/shell/tool-pwsh-persistent`）
