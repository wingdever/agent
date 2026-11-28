# `terminal_send`

## name

`terminal_send`

## description

模型收到的工具说明原文：

```text
Send text to a persistent terminal. By default Enter is submitted and the call waits for a prompt, stdin wait, output silence, timeout, or session exit. Background mode returns a job id for job_output/job_kill.
```

## system-section

本段落与同组工具共用，由同一个注册点提供：

- 段落名：`tool:pty`
- 序号（section order）：`TOOL_PTY`（1700）
- 注册位置：`packages/experimental/tool-terminal/src/index.ts:164`
- 非空条件、原文与变体：同组工具共用同一段文本，逐字模板见 [`terminal_open`](terminal_open.md) 的 system-section；文本本身不再在本页重复。


## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id returned by terminal_open or terminal_list."
    },
    "text": {
      "type": "string",
      "description": "UTF-8 text to write to the terminal."
    },
    "submit": {
      "type": "boolean",
      "description": "Submit Enter after text (default true). Set false for control characters or incomplete REPL input."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Return a job id immediately; collect with job_output or stop with job_kill."
    }
  },
  "required": [
    "sessionId",
    "text"
  ]
}
```

## result-format

返回终端回显或会话列表；`read` 支持增量读取。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 同 `terminal_open`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `ctx.terminals` 装配 | 六件套披露，共用段落 |
| `terminal-panel` 挂载 | 侧栏终端段落同时出现 |

## 来源

- 包：`@deepseek-ai/dsh-tool-terminal`（`reference/deepseek-harness/packages/experimental/tool-terminal`）
