# `terminal_open`

## name

`terminal_open`

## description

模型收到的工具说明原文：

```text
Create a persistent, owner-isolated terminal session from a registered backend type. Use this for shell or REPL state that must survive across tool calls.
```

## system-section

- 段落名：`tool:pty`
- 序号（section order）：`TOOL_PTY`（1700）
- 注册位置：`packages/experimental/tool-terminal/src/index.ts:164`
- 非空条件：注册了终端工具即贡献；六件套共用

原文：

```text
Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "description": "Registered terminal backend type, usually \"shell\"."
    },
    "name": {
      "type": "string",
      "description": "Optional owner-local display name such as \"main\" or \"gdb\"."
    },
    "cwd": {
      "type": "string",
      "description": "Initial working directory, relative to the Session current directory when not absolute."
    }
  },
  "required": [
    "type"
  ]
}
```

## result-format

返回终端会话句柄（id、名称、初始目录）。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 实验工具；组合装配 `ctx.terminals` 后按需挂载。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `ctx.terminals` 装配 | 六件套披露，段落 `tool:pty` 出现 |
| `terminal-panel` 挂载 | 侧栏终端段落 `tool:pty-panel` 一并出现 |

## 来源

- 包：`@deepseek-ai/dsh-tool-terminal`（`reference/deepseek-harness/packages/experimental/tool-terminal`）
