# `wait_agent`

## name

`wait_agent`

## description

模型收到的工具说明原文：

```text
Wait for input at your next step, including agent messages, completion notifications, and user steering. Returns immediately if new input is pending. `timedOut: false` means new input is pending. Pending input is delivered to the model after code execution finishes.
```

## system-section

不贡献系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "timeout_ms": {
      "type": "integer",
      "description": "Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000."
    }
  }
}
```

## result-format

返回 `{ timedOut, … }`：有新输入时为 `timedOut: false`；待投递输入在代码执行结束后进入模型。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `tool-subagent-control` 挂载时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `Tool-subagent-control` 挂载 | 与 `send_message` 一起出现；Team 工具改变任务不会结束 `wait_agent` |
| Team 模式启用 | `team:policy` 段落说明共享任务的改变不会唤醒 `wait_agent` |

## 来源

- 包：`@deepseek-ai/dsh-tool-subagent-control`（`reference/deepseek-harness/packages/subagent/tool-subagent-control`）
