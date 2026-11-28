# `subagent_oar`

## name

`subagent_oar`

## description

模型收到的工具说明原文：

```text
Delegate a self-contained task to a configured external agent. Choose its runtime for each call. The child works in its own context and does not see this conversation. This tool returns the child's name; a later completion notice includes its final answer. The child does not accept follow-up messages. Start independent tasks together and continue useful work while they run. When only waiting for their results remains, end your turn instead of polling.
```

## system-section

`@deepseek-ai/dsh-experimental-tool-subagent-oar` 不注册独立系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "runtime": {
      "type": "string",
      "description": "Configured external runtime for this task.",
      "enum": [
        "codex",
        "claude"
      ]
    },
    "description": {
      "type": "string",
      "description": "A short description of the delegated task, for display."
    },
    "name": {
      "type": "string",
      "description": "Optional short name for the subagent, unique among the subagents you create: lower-case letters, digits, and hyphens, starting with a letter, at most 32 characters; lead is reserved for the root agent. Omitted names default to agent-1, agent-2, and so on."
    },
    "prompt": {
      "type": "string",
      "description": "The complete, self-contained task. Include all context the external agent needs."
    },
    "cwd": {
      "type": "string",
      "description": "Initial child working directory. Relative paths use your current directory; omission inherits it."
    }
  },
  "required": [
    "runtime",
    "description",
    "prompt"
  ]
}
```

## result-format

返回子代理或外部执行器的最终回复。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 实验工具，仅在挂载该插件的组合中出现。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 组合挂载 OAR 提供者 | 按实验包配置出现；与 `subagent` 共用委派语义但不共用段落 |
| 组合未挂载 OAR 提供者 | 工具不出现 |

## 来源

- 包：`@deepseek-ai/dsh-experimental-tool-subagent-oar`（`reference/deepseek-harness/packages/experimental/tool-subagent-oar`）
