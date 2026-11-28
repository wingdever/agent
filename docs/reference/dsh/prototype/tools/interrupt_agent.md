# `interrupt_agent`

## name

`interrupt_agent`

## description

模型收到的工具说明原文：

```text
Ask a subagent to stop its current work. This call returns without waiting for it to stop. You can continue a local subagent's conversation later with send_message. External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running.
```

## system-section

不贡献系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "agent": {
      "type": "string",
      "description": "The name of an agent created under you: your direct child or a deeper descendant."
    }
  },
  "required": [
    "agent"
  ]
}
```

## result-format

返回中断请求的确认，不等待目标停止。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `tool-subagent-control` 的 `interrupt: true` 时注册（shipped Web 预设为 `false`）。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `tool-subagent-control` 的 `interrupt` 关闭 | 不注册，模型看不到这个工具（shipped Web 预设即如此） |
| `interrupt` 开启 | 与 `send_message`、`list_agents` 一起出现，`send_message` 描述中出现“可以稍后再继续对话”的语义 |

## 来源

- 包：`@deepseek-ai/dsh-tool-subagent-control`（`reference/deepseek-harness/packages/subagent/tool-subagent-control`）
