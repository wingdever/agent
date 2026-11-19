# `send_message`

## name

`send_message`

## description

模型收到的工具说明原文：

```text
Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation.
```

## system-section

不注册独立段落；协作指引由运行时上下文 `subagent:identity` 提供（见 communicate-contract.md 3.5）。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "agent": {
      "type": "string",
      "description": "The name of another agent in your subagent tree, as shown by list_agents."
    },
    "message": {
      "type": "string",
      "description": "The message to deliver to the agent."
    }
  },
  "required": [
    "agent",
    "message"
  ]
}
```

## result-format

返回投递确认（工作中的 agent 在下一步收到；空闲 agent 因此开启新一轮）。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `tool-subagent-control` 挂载时注册；`interrupt` / `wait` 等能力由配置开关。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `list_agents` 同时可见 | `subagent:identity` 追加 `Use list_agents({}) to find your collaborator agents and their names.` |
| `list_agents` 不可见 | `subagent:identity` 只保留 `send_message` 那一行 |
| `interrupt_agent` 关闭 | 不注册；`send_message` 的投递语义不变 |

## 来源

- 包：`@deepseek-ai/dsh-tool-subagent-control`（`reference/deepseek-harness/packages/subagent/tool-subagent-control`）
