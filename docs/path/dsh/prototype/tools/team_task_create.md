# `team_task_create`

## name

`team_task_create`

## description

模型收到的工具说明原文：

```text
Create one unowned pending task on the shared Team task board.
```

## system-section

- 段落名：`team:policy`
- 序号（section order）：`TEAM_POLICY`（600）
- 注册位置：`packages/team/tool-agent-team/src/index.ts:112`
- 非空条件：Team 模式对该 agent 开启时

原文：

```text
Agent Teams is available in this session.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Use the names returned by subagent, subagent_fork, or list_agents as owner when assigning or filtering shared tasks. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. The root agent must wait for required teammates before giving the final answer.

Task changes do not end wait_agent calls, add inbox messages, or start idle agents. Use send_message when another agent needs to act on a task.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string",
      "description": "Concise task title."
    },
    "description": {
      "type": "string",
      "description": "Complete task details and acceptance criteria."
    },
    "blocked_by": {
      "type": "array",
      "description": "Task ids that must complete first.",
      "items": {
        "type": "string"
      }
    },
    "write_scopes": {
      "type": "array",
      "description": "Advisory workspace-relative file or directory prefixes this task expects to modify.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "subject",
    "description"
  ]
}
```

## result-format

返回任务视图（含 id、revision、status、owner）。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `agent-team` 与 `tool-agent-team` 同时挂载且该 agent 启用 Team 模式时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| Team 模式对该 agent 关闭 | 四个 Team 工具都不披露，`team:policy` 段落为空 |
| Team 模式开启 | `team:policy` 段落出现，四个工具同时可调 |
| `subagent` / `send_message` 可见 | 段落里的 owner 语义引用这些工具名 |

## 来源

- 包：`@deepseek-ai/dsh-tool-agent-team`（`reference/deepseek-harness/packages/team/tool-agent-team`）
