# team-policy（功能）

Agent Teams 的协作策略段。它只负责**贡献一个受激活谓词驱动的 section**，规则部分见 `system-prompt.md`。

## 1 它在什么时候出现

- Team 模式对该 agent 开启时非空；关闭时为空串，不进入系统提示词。
- 判定在每个候选 step 的组装期进行（工具注册时的 `when` 谓词），随模式切换在下一步生效。

## 2 它注入什么

`team:policy`（`TEAM_POLICY`，600）：

```text
Agent Teams is available in this session.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Use the names returned by subagent, subagent_fork, or list_agents as owner when assigning or filtering shared tasks. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. The root agent must wait for required teammates before giving the final answer.

Task changes do not end wait_agent calls, add inbox messages, or start idle agents. Use send_message when another agent needs to act on a task.
```

## 3 它如何配合规则

- **排序**：`TEAM_POLICY`（600），在计划态策略之后、工具指引之前。
- **动态性**：段落提供者是函数，依据 Team 模式与 agent 身份返回文本或空串。
- **可见性**：Team 的四个工具本身也受同一个 `when` 谓词控制，模式关闭时工具与段落一起消失。

## 4 组合条件

- 与 `plan-mode` 同时存在时按序号先后出现（500 → 600）。
- 与 `subagent` 组同时存在时，段落里的 owner 语义引用这些工具名。
