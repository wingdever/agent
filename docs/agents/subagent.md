# subagent 子代理

## 1 范围

子代理是 agent 的内含委派能力：主 agent 把一个任务交给子 agent，子 agent 在独立上下文里跑完整轮次，结果回到父会话。

- **两种委派模式**：`subagent` 从零开始，`subagent_fork` 继承父会话已完成的轮次。
- **可续**：子会话是持久会话，可由 `send_message` 再次唤醒。
- **不是团队**：生命周期从属于调用它的 agent，没有角色分工与编队。团队由编排层另行组建。
- **树形**：任一子代理可再委派，层数不设上限；`subagent` 只允许从主会话发起，`subagent_fork` 在任意会话可用。

## 2 与 model 的契约

### 2.1 委派工具

两个工具的 `description` 前半段不同，后半段相同。

`subagent`：

> Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes.

`subagent_fork`：

> Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes.

参数（两者相同）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | string | 否 | `Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.` |
| `description` | string | 是 | `A short (3-5 word) description of the delegated task, for display.` |
| `name` | string | 否 | `Optional short name for the subagent, unique among the subagents you create: lower-case letters, digits, and hyphens, starting with a letter, at most 32 characters; "lead" is reserved for the root agent. Omitted names default to agent-1, agent-2, and so on.` |
| `prompt` | string | 是 | `subagent`：`The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs.`；`subagent_fork`：`The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new.` |

执行后立即返回 `started subagent <name>`，不等待子代理结束、不返回结果。子代理结束后由运行时投递结算通知。

### 2.2 system prompt 段

委派指引段由当前可见的委派工具集合整体生成，工具名用 `or` 连接，两个都可见时：

> Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.
>
> Bash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly. The agent integrating the work must review the final diff and run relevant tests.

工具清单对所有会话相同：委派工具始终出现在 `payload.tools` 与 system prompt 里，不按会话种类裁剪。工具清单是请求前缀的一部分，按会话裁剪会让前缀缓存失效。

### 2.3 身份段

子代理的身份段、委派范围与协作指引由运行时上下文提供，内容随会话类型与可见工具变化。

## 3 子会话构造

子会话是新建的持久会话，`kind=subagent`，实例经 Agent 注册表按需创建，与父会话同 workspace。

- **spawn**：零父上下文，只收到一条任务 prompt，不读父会话的消息、轨迹或历史。
- **fork**：看到父会话在继承点处的模型可见历史，在其上继续。父会话当前在途的轮次不进入继承范围。

system prompt 装配、轮次语义、事件隔离与主会话相同；子代理的事件发往自己的会话轨迹，不并入父会话事件流。

**工具面**：子代理可见工具与父轮次一致，不裁剪。`subagent` 在子会话工具清单里仍在，但执行时拒绝——它只允许从主会话发起；`subagent_fork` 在所有会话可用，多层树由此成立。

**权限**：子代理的每次工具调用都经与主 agent 相同的权限门。权限 scope 在启动时固定，会话内不可放宽；审批策略钉死为不自动弹审批，`ask` 档工具在子作用域直接拒绝，不挂起、不发审批请求。被拒操作不重试，限制写进回复交由父 agent 处理。运行时上下文里的委派范围一段就是这条约束的模型侧说明。

**启动方式**：委派先创建子会话与对应实例，再把任务 prompt 作为该实例 `nextTurn` 的第一条输入入队并唤醒，领取后以 `source=subagent-prompt` 落库。工具调用在入队完成时返回 `started subagent <name>`，不等子代理跑完。

## 4 结算

子代理一轮结束时，运行时构造一条结算通知投递给父会话。

首行是一句完整结算语，主语固定为 `Background subagent <name>`，按结束原因整句替换：

| 结束原因 | 文案 |
|---|---|
| `completed` | `Background subagent <name> finished and will do no further work unless you send it more.` |
| `aborted` | `Background subagent <name> was stopped before it finished.` |
| `max-tokens` | `Background subagent <name> ran out of room before it finished.` |
| `refusal` | `Background subagent <name> declined the task.` |
| `error` | `Background subagent <name> failed before it finished.` |

其后是 `Its closing message:` 加子代理末轮 assistant 文本；无文本时用 `It left no closing message.`。若子代理在结束前的最后一个动作是给父级发 `send_message`，且此后没有领取输入或记录工具调用，收尾文本替换为 `It sent you a message just before finishing, so its closing message is omitted.`，避免同一结果重复两遍。

失败时附诊断：由运行时产出安全的失败说明而非异常原文，按 4096 字节以 UTF-8 截断（不切断多字节字符），超限部分替换为 `\n[diagnostic truncated]`。

投递走父会话的 inbox：父忙则进 `nextStep`，父闲则进 `nextTurn` 并唤醒。结算通知领取后以 `source=subagent-settle` 落库，是父会话里一条普通 user 消息，不带 `tool_call_id`，父模型在后续轮次里把它当新输入读到。

未领取的结算通知随进程退出丢失；恢复入口是从子会话历史重新接入结算，作为显式操作发起。父会话已删除时结算丢弃并记录告警，不暂存、不补发。

## 5 控制面

### 5.1 send_message

参数 `agent`（`list_agents` 里显示的名称）与 `message`，返回投递回执，不返回回答。

> Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation.

- 运行中的目标：进 `nextStep`，下一个 step 前注入。
- 空闲的目标：进 `nextTurn` 并唤醒一轮。
- 消息正文前缀为 `Agent <sender-name> sent a message: `，落库 `source=agent-message`。

授权：发送方必须是同一棵树内的成员，目标不能是自己；同树判定以会话树根是否相同为准。

### 5.2 interrupt_agent

参数 `agent`（调用方的后代），调用在请求被接受时返回，不等目标停稳。

> Ask a subagent to stop its current work. This call returns without waiting for it to stop. You can continue a local subagent's conversation later with send_message. External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running.

授权：调用方必须是目标的祖先（直接父级或更深），自己、兄弟、无关树的调用都拒绝。已空闲的目标是成功空操作。

中断只 abort 目标实例当前轮次的控制器，保留 inbox 与后代；恢复时由下一次输入新建控制器。

### 5.3 list_agents

无参数，返回整棵树：根、所有可达的可续后代，含调用方自己。

> List your entire subagent tree: the root agent and all reachable continuable descendants, including yourself. Rows carry names, descriptions, and status. A descendant's name is its path from the root, such as reviewer/checker. You can message any other agent in the subagent tree. running means it is working; inactive means no turn is executing; it does not indicate task completion, success, or failure. While you remain active, you will be notified when a direct child finishes; there is no need to keep checking its status. Use send_message to continue the conversation.

每行渲染为 `<name> [<status>] — <description>`，根行固定为 `lead [<status>] — root agent`。`description` 取子会话的 `sessions.name`。本部署只有本地子代理，status 只取 `running` 与 `inactive`。

### 5.4 wait_agent

参数 `timeout_ms`（10000–3600000，默认 30000），返回 `{ timedOut }`。等待本 agent 的 `nextStep` 出现未报告过的输入，不消费输入。它让空闲的子代理在等待协作消息时不空转轮次。

## 6 名称与寻址

- **名称规则**：1–32 位小写字母、数字或连字符，以字母开头，不能是 `lead`；同父的子级之间唯一。省略时取第一个空闲的 `agent-N`。规则不符或重名在启动前拒绝。
- **根的名称**固定为 `lead`，不落库。
- **完整名称**是从根开始的斜杠路径，不带 `lead/` 前缀：`reviewer`、`reviewer/checker`。
- **解析**：`lead` 或完整路径返回对应 session id；不是路径文本按 session id 原样处理；指向无成员的斜杠路径报名称不存在。
- **解析不授予权限**：消息与中断都按解析出的 session id 再校验同树或祖先关系。

## 7 存储与轨迹

- `sessions`：子会话一行，`kind=subagent`。
- `subagents`：`sub_sess_id`（唯一）、`par_sess_id`、`agent_name`、`discarded_at`；`(par_sess_id, agent_name)` 唯一。
- `session_forks`：仅 fork 写一行，记录父会话与继承点。
- `subagent_prompts`：委派 tool_call 与子会话首条 user 消息的关联。
- `subagent_settles`：子代理末轮输出消息与父会话结算消息的关联。
- 子代理的消息、轮次、步骤落在同一套关系表里，以 session id 区隔。

## 8 取消、预算与失败

- 子代理比父轮次活得久：每个实例持有自己的 abort 控制器，父轮次取消不中止已派发的子代理，也不影响其 inbox。
- 单次模型请求的 `max_tokens` 由会话设置决定，触顶产出 `max-tokens` 结算。
- 子轮次抛异常、模型或传输失败压平为 `error` 结算，异常不向上抛到父轮次。

## 9 fork 继承与删除

- **继承点**：fork 在创建子会话时写定父会话的继承边界，取父最后一个已完成轮次。父之后新增轮次或再次压缩都不改变子看到的继承段。
- **继承段只读**：子代理可以压缩继承段（吸收进自己的摘要），不能修改父会话的消息；父的压缩也不得改写边界之前的继承段内容。
- **历史不复制**：fork 只在 `session_forks` 记一行继承点，回放时递归拼接父会话历史。子会话自己产生压缩后，祖先内容已吸收进摘要，回放不再访问父会话。
- **删除级联**：硬删会话沿 `session_forks` 与 `subagents` 两条边递归删除全部后代；软删只标记自身，不动后代与会话历史。
