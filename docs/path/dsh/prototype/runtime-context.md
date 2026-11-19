# runtime-context（驱动）

运行时上下文规则。本文件是**定义性**的：所有以 `<system-reminder>` 快照形式进入模型历史的事实，都按这里的规则产生、去重与刷新；各功能只说明自己提供哪一条、内容是什么。驱动的清单见 `communicate-contract.md`。

## 1 职责与边界

运行时上下文与系统提示词是两条不同的通道：

| | 系统提示词（section） | 运行时上下文（context） |
|---|---|---|
| 落在哪里 | system 消息文本 | user 角色消息 |
| 何时变 | 文本变化时改写或追加 system 节点 | 命名贡献（名字或文本）变化时追加新快照 |
| 是否参与排序 | 按 order 与名字排序 | 只按 order 升序 |
| 是否可抑制 | 不参与 | 可选条目可被 `suppressRuntimeContext()` 抑制 |

它负责：收集 context 提供者、排序、渲染、封装快照帧、按结构化比较去重、压缩后再补发。

它不负责：section 的组装与排序（见 `system-prompt.md`）、具体条目的事实来源（各功能与工具负责）、快照如何写进历史（见 `communicate-contract.md` 的准入规则）。

## 2 完整清单

| 名称 | order | 提供者 | required | 非空条件 |
|---|---|---|---|---|
| `working-directory:current` | 100 | `dsh-working-directory` | 是 | 有 agent |
| `sandbox:policy` | 110 | `dsh-sandbox-policy` | 否 | 会话可解析 |
| `approval:policy` | 115 | `dsh-user-approval` | 否 | 有 agent |
| `tool:subagent:depth` | 120 | `dsh-tool-subagent` | 否 | 该工具已达委派深度上限 |
| `tool:subagent_fork:depth` | 120 | `dsh-tool-subagent`（fork 行） | 否 | 同上 |
| `tool:reviewer_delegate:depth` | 120 | 自定义 subagent 工具 | 否 | 同上 |
| `subagent:identity` | 120 | `dsh-tool-subagent-control` | 是 | 有 agent |
| `subagent:delegation` | 120 | `dsh-subagent` | 否 | 仅子会话 |
| `timeline:state` | 120 | `dsh-timeline` | 是 | 有 agent、非 worker、存储可用 |
| `timeline:maintenance` | 121 | `dsh-timeline` | 是 | 连续 2 轮未更新任务树 |
| `harness:source` | 200 | `dsh-harness-dev-context` | 否 | Web 组合装了该插件 |
| `app:web-surface` | 210 | `dsh-harness-dev-context` | 否 | Web 组合装了该插件 |

`CONTEXT_ORDERS`：

| 名称 | 值 |
|---|---|
| `WORKING_DIRECTORY` | 100 |
| `SANDBOX_POLICY` | 110 |
| `APPROVAL_POLICY` | 115 |
| `SUBAGENT_DELEGATION` | 120 |
| `HARNESS_SOURCE` | 200 |
| `WEB_SURFACE` | 210 |

context 只按 `order` 升序排列，同 order 保持注册顺序；`required: true` 的条目在可选上下文被抑制时仍然保留。

`time-context` 不注册运行时上下文：它经 `agent/pre-step` 注入独立的时间消息，见 `communicate-contract.md` 的消息通道。

## 3 刷新与去重

- 组装阶段解析出 `contexts`；准入前调用 `refreshContext()` 只重新解析 context 提供者，section、tools、变量与瀑布都不重跑。
- 快照按**命名贡献的有序列表**比较（名字与文本），而不是比较整段措辞；措辞调整不算变化。
- 只有变化时才追加新快照；不变时什么都不写。
- 快照被压缩吸收后，下一次合格请求会重新补发。
- 抑制状态下可选条目移除，缺失的 `required` 条目按注册顺序补回。

## 4 帧模板

封装函数 `joinContextSections` 与 agent-loop 的运行时投影共同决定文本。第一次快照与后续快照的开场句不同：

```text
<system-reminder>
The following information describes your current session:

<contribution 1>

<contribution 2>
</system-reminder>
```

后续发生变化时的快照：

```text
<system-reminder>
The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.

<contribution 1>

<contribution 2>
</system-reminder>
```

没有任何贡献时的清除帧：

```text
<system-reminder>
Current runtime context: none. Earlier runtime-context snapshots no longer apply.
</system-reminder>
```

正在合成的快照会把贡献里的 `</system-reminder\s*>` 转义成 `<\\/system-reminder …>`，防止正文提前闭合帧。封装只是格式约定，不构成安全边界。

## 5 条目模板

### 5.1 工作目录

```text
Current working directory: "<absolute path>".
```

`required: true`，`interpolate: false`。工作目录服务同时注册一个 prepend 的 `system-prompt/assemble` 监听器：进入时先 `ensure()` 校验目录仍存在（丢失则回退到会话原始目录并提交一次变更），瀑布返回后把 context 文本刷新为当前值并提到首位。

### 5.2 沙箱策略

```text
Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.
```

```text
Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "<workspace root>".<extra> Some platform temporary areas may also be writable.
```

```text
Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.
```

`<extra>` 在有附加可写根时为 `` Additional writable directories: [<json>]. On Windows, these additional grants apply to file tools only, not sandboxed processes.``，否则为空。

### 5.3 审批策略

```text
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

```text
Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

### 5.4 子代理身份

根代理：

```text
You are the root agent. Your name is "<self>".
```

子代理：

```text
You are a subagent delegated by agent "<parent>".
Your name is "<self>".
The root agent of your collaboration tree is "<root>".
```

在两段身份之后，若 `send_message` / `list_agents` 可见，各自追加一行，中间隔一个空行：

```text
To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).
Use list_agents({}) to find your collaborator agents and their names.
```

根代理不可用时：

```text
Your agent id is "<id>". Your subagent tree root is unavailable. Continue independent work; subagent discovery and messaging require an active root.
```

### 5.5 委派深度与委派上下文

```text
Delegation depth for `<tool>`: current <depth>, maximum <max>, remaining levels 0. Do not call `<tool>` at this depth; carry out the work directly.
```

```text
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

后者只注册在子会话的创建作用域上；父代理的系统提示词因此保持不变。

### 5.6 Timeline

主代理规划段：

```markdown
Before substantive multi-step work, reuse the goal's tree or start one with timeline_tree. Group work by deliverable and split large steps into checkable child tasks. Use timeline_tasks at meaningful checkpoints to update leaves and revise the tree as scope changes. Preserve completed work.

Before a final answer on planned work, save progress and call timeline_pull for that goal. Continue eligible work in scope and repeat the check. Recheck blocked dependencies once and record remaining blockers. Resume paused work only at the user's request.

Own the shared tree. Save tasks before delegating. Include "Timeline: tree=<id>; tasks=<ids>", scope, and completion criteria in assignments and reassignments. Relay relevant discussions and pause/continue requests. Save worker progress and blockers, verify results before marking tasks done, and save shared replies yourself. Save progress and yield when waiting for workers.

Interval reports run independently when enabled. Keep replies focused on the user's work.
```

末尾再追加一行语言策略（语言由配置与界面语言决定，`<label>` 如 `English`）：

```text
For Timeline task-tree content only, write titles, descriptions, progress notes, results, and discussion replies in <label>. Follow the user's language instructions for all other work and conversation.
```

worker 规划段（替换上述整段）：

```markdown
The manager owns the shared Timeline tree. At milestones, blockers, and completion, report the assigned tree/task IDs, verified results, and remaining work to your parent through normal agent messages. Ask for missing IDs at the first checkpoint. Follow the latest assignment and pause/continue requests at safe checkpoints. Send discussion findings to your parent for a saved reply. Pass the same references if you delegate further.
```

状态 context（`timeline:state`）：

```text
Current Timeline plan (turn-start state, not a new request): {"selectedTree":"<id>","trees":[{"id":"<id>","title":"<t>","status":"<s>","unfinished":<n>,"groups":[…],"tasks":[…]}],"priorities":[…]}
```

`trees` 只保留活动树的内层字段；同一 signal 下整轮复用首次求值结果。存在未处理讨论时追加：

```text
Address open discussions at a safe checkpoint. Use timeline_read with annotation set to the ID if you need the full message or context. Save replies with timeline_reply. Apply pause or continue to the requested scope before confirming it.
```

worker 的 `timeline:state` 换成委派引用：

```text
Timeline delegation: parent <parent>[; plan owner <owner>][; current tree <id>: "<title>"]. These are references, not assignments. Use the tree/task IDs in the latest assignment message; report missing IDs to the parent.
```

无父会话时为：

```text
Report assigned work to the delegating agent.
```

维护提醒（`timeline:maintenance`，连续 2 轮无更新时出现）：

```text
Task progress checkpoint: Save changes to the current goal’s tree, or start one if this multi-step goal has none. Use timeline_pull when choosing the next task.
```

### 5.7 harness 自身与 Web 界面

`harness:source` 与 `app:web-surface` 在各有一份 section 的同时，也各注册一份 context，把注册时无法固定的值（副本路径、GUI 地址）留给每次组装：

```text
Current DeepSeek Harness implementation checkout: "<checkout root>".
```

```text
Current DeepSeek Harness Web GUI URL: "<advertised url>".
```

两份 context 都是可选条目：`includeRuntimeContext: false` 或作用域抑制时不会出现；对应的 section 则始终存在。

## 6 注册 API

```ts
interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean
  readonly required?: boolean
}

context(context: PromptContext): () => void
getContextOrder(name: PromptContextOrderName): number
suppressRuntimeContext(): () => void
```

## 7 何时刷新

| 时机 | 发生什么 |
|---|---|
| 组装（每候选 step 首次尝试） | 解析全部 context 提供者 |
| 准入前（每次请求） | `refreshContext()` 重新解析 context 提供者，并补回缺失的 required 条目 |
| 每次尝试（含重试） | 重新比较快照，变化才写 |

快照写入与去重的完整规则见 `communicate-contract.md` 的准入规则；可抑制的时机见 `persona.md`。
