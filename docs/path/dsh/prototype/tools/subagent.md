# `subagent`

## name

`subagent`

## description

模型收到的工具说明原文：

```text
Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes.
```

## system-section

- 段落名：`tool:<toolName>`
- 序号（section order）：`TOOL_SUBAGENT`（2800）
- 注册位置：`packages/subagent/tool-subagent/src/index.ts:369`
- 非空条件：本提供者已挂载，且该工具在可见委派组中排第一

原文：

```text
Start independent delegations with `<name>` or `<name>` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.

Bash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly. The agent integrating the work must review the final diff and run relevant tests.

（`<name>` 为本作用域可见的委派工具，升序后用 ` or ` 连接；只有名字排序第一的工具贡献非空段落）
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "cwd": {
      "type": "string",
      "description": "Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent."
    },
    "description": {
      "type": "string",
      "description": "A short (3-5 word) description of the delegated task, for display. Use the language of the user's current request."
    },
    "name": {
      "type": "string",
      "description": "Optional short name for the subagent, unique among the subagents you create: lower-case letters, digits, and hyphens, starting with a letter, at most 32 characters; lead is reserved for the root agent. Omitted names default to agent-1, agent-2, and so on."
    },
    "prompt": {
      "type": "string",
      "description": "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
    }
  },
  "required": [
    "description",
    "prompt"
  ]
}
```

## result-format

返回子代理的最终回复文本，或失败诊断；可选 `outputSchema` 时返回结构化结果。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 提供者已注册时按 `provider`（spawn / fork）挂载。
- 受委派深度上限限制，到达上限时 `tool:subagent:depth` 运行时上下文出现。
- 委派工具名可通过 `toolName` 配置。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `subagent_fork` 同时可见 | 两者共用一个段落；只有名字排序第一的（`subagent`）贡献非空文本，`subagent_fork` 贡献空串 |
| 只有 `subagent_fork` 可见 | 改由 `subagent_fork` 贡献原文，工具名列表里出现 `` `subagent_fork` `` |
| 两者都不可见 | 整段为空，不进入系统提示词 |
| 到达委派深度上限 | 额外出现运行时上下文 `tool:subagent:depth`，提示该深度不能再委派 |
| `toolName` 改为别的名字 | 段落名随之变为 `tool:<新名字>`，序号仍是 `TOOL_SUBAGENT`（2800） |
| `list_subagent_models` 同时可见 | 模型可先查可选模型再委派；不改变段落文本 |
| `send_message` / `list_agents` 存在 | 运行时上下文 `subagent:identity` 追加协作指引行 |
| 执行器换成 PTC | `tool:<toolName>` 段落整体失效，改用 `tools:sdk` |

### 展示投影

子代理的起止、消息与结果由会话事件驱动呈现，不属于工具自身的 `presentResult`。

## 来源

- 包：`@deepseek-ai/dsh-tool-subagent`（`reference/deepseek-harness/packages/subagent/tool-subagent`）
