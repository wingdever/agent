# `list_agents`

## name

`list_agents`

## description

模型收到的工具说明原文：

```text
List your entire subagent tree: the root agent and all reachable continuable descendants, including yourself. Rows carry names, descriptions, and status. A descendant's name is its path from the root, such as reviewer/checker. You can message any other agent in the subagent tree. running means it is working; inactive means no turn is executing; it does not indicate task completion, success, or failure. corrupt, unsupported, or unavailable means this row's own descendants could not be read; the row itself is still a member you can message. While you remain active, you will be notified when a direct child finishes; there is no need to keep checking its status. Use send_message to continue the conversation.
```

## system-section

协作指引由运行时上下文 `subagent:identity` 提供。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {}
}
```

## result-format

返回根代理与全部可达的可续派生子代理。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `tool-subagent-control` 挂载时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `send_message` 同时可见 | `subagent:identity` 同时包含两行协作指引 |
| 处于根代理 | `subagent:identity` 文案为根代理版本 `You are the root agent. Your name is "<self>".` |
| 处于子代理 | `subagent:identity` 文案为子代理版本，并给出父代理与协作树根名 |

## 来源

- 包：`@deepseek-ai/dsh-tool-subagent-control`（`reference/deepseek-harness/packages/subagent/tool-subagent-control`）
