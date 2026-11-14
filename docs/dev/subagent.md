# subagent 子代理系统
seam: ctx.subagents

1. backgroundMode: one-shot,continue

one-shot ctx.subagents.start(name, request)
continue startContinuable(spec) / followup / interrupt

2. provider: spawn,fork,acp(agent client protocol)

spawn: inherit with new session history in same process
fork: as spwan except inherit session history in same process
acp: only inherit worksapce in new process




## tool-subagent
packages/subagent/tool-subagent/src/{index,model-selection,model-selection-settings,list-models}.ts
agentOptions: { provider, model, reasoningEffort, maxTokens }
    subagent-model-selection
    modelSelectionSettings: true
    list_subagent_models

getProvider:
    spawn/fork same process
    acp/dsh-sdk new subprocess
    claude-code/codex bridge CLI
return:
    run.result
    reportFrom

```ts
// 请求可:选模型、要求结构化输出、限制委托深度、限制子 Agent 工具、设子 persona
const run = await ctx.subagents.start('spawn', {
  prompt: '帮我分析这个仓库的 TODO',
  outputSchema,          // 可选:强约束最终结果结构
  depthLimit,            // 可选:封顶委派深度
  toolFilter,            // 可选:限制子 Agent 可见工具
  signal,                // 必填:发布前的取消通道
})
const result = await run.result   // 一次性子 Agent 的最终结果
```
## tool-subagent-control
send_message / interrupt_agent / list_agents



```ts
const { childId, messageId } = await ctx.subagents.startContinuable({
  label: 'research-assistant',
  initialPrompt: '这是一个常驻研究助手,随时找我',
})
// 后续发消息(精确的直接父 agent 认证后才放行)
await ctx.subagents.followup(parent, childId, '再查一下 MCP 最新进展')
// 打断一个可续子 Agent 的当前轮次(保留其 inbox 与后代)
await ctx.subagents.interrupt(targetSessionId, authority)
// 列直接会话级子 Agent / 拉平整棵会话树
await ctx.subagents.listChildren(parentSessionId)
await ctx.subagents.listDescendants(rootSessionId)
```

## tool-workflow
run a JS chestrate script section fan out subagents.
@deepseek-ai/dsh-tool-workflow ctx.workflowEngine
dsh-workflow-worker-thread

```
meta    必填身份数据: { name, description, phases? }
script  必填纯 JS 函数体(顶层 await;不要 export const meta)
args    可选 JSON,作为 args 全局暴露给脚本
```

usable chestrate hook: agent / pipeline / parallel / phase / log

## tool-ralph
for a same goal, run a new agent to iterate each time.
which schedule as fresh-agent iterative loop


# 第一步实现

子代理系统提供一次性委派：主 Agent 把一个自包含任务交给独立的子 Agent 执行，子 Agent 在独立上下文中跑完整轮次，其结果以一条 user 消息回灌父会话，并触发父 Agent 的新一轮处理。

与 model 的通信契约以已安装运行时 `@deepseek-ai/dsh@0.2.1-rc.2` 的编译产物为准，位于 `~/.nvm/versions/node/v24.22.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*/lib/`。下文逐字引用的文案与参数均出自该版本，并标注来源文件。

## 1. 范围

- 委派模式：one-shot，子 Agent 跑完即止，不接受后续消息。
- 子上下文：spawn，子 Agent 不继承父会话的任何轮次，task prompt 必须自包含。
- 工具清单对所有会话相同：`subagent` 始终出现在 `payload.tools` 与 system prompt 里，子会话调用时在执行层拒绝。工具与 system prompt 是请求前缀的一部分，按会话裁剪会让前缀缓存失效。
- 常驻子代理与会话树、`send_message` / `interrupt_agent` / `list_agents` 控制面、workflow / ralph 编排、agent-team 协作层分属协作与编排层，不在本子系统内。

## 2. 与 model 的通信契约

### 2.1 subagent 工具定义

工具经 `tools/subagent/registry.json` 注册，其 `name` / `description` / `parameters` 进入 `payload.tools` 下发给 model。

本子系统的一次性 provider 不提供 `prepareContinuable`：零父上下文 wording 与一次性后端文案是两个独立开关，此处按本项目的 provider 组合拼接成完整串（来源 `dsh-tool-subagent/lib/index.js:337-346,384`）：

> Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes. The completion notice includes its final answer. This backend does not accept follow-up messages.

`parameters`：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | string | 否 | `Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.` |
| `description` | string | 是 | `A short (3-5 word) description of the delegated task, for display.` |
| `prompt` | string | 是 | `The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs.` |

工具执行后立即返回 `started subagent <id>`（来源 `dsh-tool-subagent/lib/index.js:420-440,473-482`），不等待子 Agent 结束、不返回结果。`exec.signal` 作为取消通道透传给运行时。

### 2.2 system prompt 段落

`tool:subagent` 段固定注入，指引并排委派与并行工作（来源 `dsh-tool-subagent/lib/index.js:509-518`）。段落由当前可见的委派工具集合生成，工具名用 `or` 连接；只有 `subagent` 时：

> Start independent delegations with `subagent` together in one assistant message and continue useful work while they run.

两个委派工具都在时的渲染见 §8.2。

本子系统不注入按请求变化的深度上下文：不设委派深度上限，也没有 `tool:subagent:depth` 段。

### 2.3 结果回灌消息

子 Agent 结束后，运行时构造一条 user 消息投递给父会话。消息格式取自 `dsh-subagent/lib/index.js:487-539`：

- 首行是一句完整结算语，主语固定为 `Background subagent <childId>`，按 stopReason 整句替换（来源 `dsh-subagent/lib/index.js:487-500`）：`completed` → `Background subagent <id> finished. It cannot receive follow-up messages.`；`aborted` → `Background subagent <id> was stopped before it finished.`；`max-tokens` → `Background subagent <id> ran out of room before it finished.`；`refusal` → `Background subagent <id> declined the task.`；`error` → `Background subagent <id> failed before it finished.`。
- `Its closing message:` + 子 Agent 末轮 assistant 文本；无文本时用 `It left no closing message.`。
- 末轮文本即结果。结构化输出由 `structured_output` 工具与强制指令承载（来源 `dsh-subagent/lib/index.js:873-879`），本子系统不启用，也不产生 `Structured result:` 行。

该消息带来源标记 `{ kind: "subagent-settled", form: "notice", summary, senderSessionId }`，`senderSessionId` 为子 Agent 的 session id（来源 `dsh-subagent/lib/index.js:533-539`）。它是 user 消息而非 tool result、不带 `tool_call_id`：父 model 在后续轮次里把它当作一条新输入读到。

## 3. 结果投递与自动续轮

子 Agent 结束时，运行时把 settlement 消息插入 `messages` 表（`role=user`，`source=subagent-settle`，带 `surface_seq`，不带 `tool_call_id`），随即触发一轮无用户输入的 `chat()`。该轮 `resolve-input` 取到的最后一条 user 即为这条 settlement 消息，父 model 据此消化结果并继续工作。`subagentId` 即子 Agent 的 session id，跨 `_requestMessages` 重建保持稳定，用于结算消息寻址。

自动续轮与用户发起的轮次不靠 turns / steps 上的标记区分，而由该轮首条结算 user 消息的 `source=subagent-settle` 标识：轨迹中读到该消息即可判定本轮非用户输入触发。one-shot 委派返回后父轮次即结束，结果到达时父 Agent 处于空闲，仅走自动续轮这一条路径，不存在运行中的即时注入。

## 4. 子 Agent 构造

### 4.1 上下文与 system prompt

子 Agent 在同一进程内以独立 `ctx` 运行：新建 session、独立装配 system prompt、零父上下文。它只收到一条 task prompt，不读父会话的 surface、transcript 或任何历史消息。

system prompt 复用 `assembleSystemPrompt`：身份、persona、语言策略、运行时上下文按 session 首轮装配一次；`tool:*` 段落来自子 Agent 本轮可见的工具清单。`{{cwd}}` 取子 Agent 自己的初始工作目录。

子 Agent 复用与主循环相同的 loop 引擎跑完整 step 循环，直到模型不再返回 `tool_calls`；末轮 assistant 文本作为 closing message 交给结算。其 `onEvent` 接到子会话自己的轨迹，不并入父会话事件流。

### 4.2 工具面

子 Agent 的工具集与父 Agent 本轮可见集完全一致，不裁剪任何工具：`payload.tools` 与 system prompt 构成请求前缀，按会话裁剪会让前缀缓存失效。`subagent` 仍在子会话的工具清单里，但执行时被拒绝——spawn 只允许从 `kind = normal` 的主会话发起。`toolFilter` / `persona` 不作为委派参数：工具组合由工具清单决定，persona 由 `user/settings.json` 的 `persona` 段落决定。

### 4.3 权限

子 Agent 的每一次工具调用都经过与主 Agent 相同的权限门：`user/permissions.json` 的工具级档位，叠加 `user/fs-policy.json` 对 `write` / `edit` 的路径规则。权限门是唯一安全边界；工具直接作用于真实系统，不设 sandbox 分支，也不解析 sandbox 相关字段。

权限 scope 在子 Agent 启动时固定，会话内不可放宽；审批策略钉死为不弹审批，无视父轮次的策略。`ask` 档工具在子作用域自动拒绝，不挂起、不发 `approval-request`；子 Agent 不重试被拒操作，把限制写进回复交由父 Agent 处理。

该约束以 runtime-context（user 消息，非 system 段）逐字注入子 Agent，使父子 system prompt 保持同一套部署文案（来源 `dsh-subagent/lib/index.js:359-363`）：

> You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.

这条消息插在 task prompt 之前、继承段之后，不插在 system 之后：fork 的继承段要与父会话的前缀逐字相同才能命中前缀缓存，插在头部会让整段继承历史失去缓存（§9.1）。

## 5. 存储与轨迹

- `messages`：settlement 以 `role=user` + `source=subagent-settle` 落一行；append-only，`surface_seq` 单调，`getSurface()` 回放时与其他消息一视同仁，压缩不改写原行。
- 子 Agent 拥有独立 session，其消息与 step 落在同一套关系表里，以 session id 区隔。
- UI 依据 `source` 把 settlement 渲染为子代理完成卡片；`system-prompt` / `user-input` 布局树不因该消息改变。

## 6. 取消、预算与异常回灌

### 6.1 取消

`exec.signal` 贯穿子 Agent 的创建与运行。子 Agent 比父轮次活得久，不复用父 turn 的 signal；运行时为每个子 Agent 持有独立 `AbortController`，父轮次取消不自动中止已派发的子 Agent。取消或中断产出 `stopReason: "aborted"`，结算首行取 `Background subagent <id> was stopped before it finished.`。

### 6.2 失控预算

- 单次模型请求的 `max_tokens` 由会话设置决定；触顶产出 `stopReason: "max-tokens"`，结算首行取 `Background subagent <id> ran out of room before it finished.`。

该上限是子 Agent 侧的硬约束，不依赖父轮次是否仍在运行。

### 6.3 失败与诊断

子 loop 抛异常、模型或传输失败时压平为 `stopReason: "error"`，结算首行取 `Background subagent <id> failed before it finished.`。`diagnostic` 由 provider 产出，是安全的失败说明而非异常原文；按 4096 字节上限以 UTF-8 截断（不切断多字节字符），超限部分替换为固定后缀 `\n[diagnostic truncated]` 后附在结算消息末尾（来源 `dsh-subagent/lib/index.js:2760-2781`）；请求了结构化输出却未捕获到有效值时同样降为 `error`。异常不向上抛到父进程。

### 6.4 结算发放门槛

结算只在子 Agent 已发布且投递目标为父会话时发放一次，同一子 Agent 的重复结算不重发。父会话已关闭、进程结束或子 Agent 被提前清理时，结算消息丢弃并记录告警，不暂存、不补发。

子 Agent 的结束原因由运行时记录，settlement 首行按 `completed` / `aborted` / `max-tokens` / `refusal` / `error` 取对应文案（来源 `dsh-subagent/lib/index.js:487-500`）；正常情况下父 Agent 总会收到一次结算消息，不会静默丢失结果。

# 第二步实现

子代理的第二种委派模式：fork。子 Agent 继承父会话截至最后一个已完成轮次的全部历史，在既有上下文上继续工作；工具名 `subagent_fork`，与 `subagent` 并存。结算投递、自动续轮、取消、失败回灌与第一步共用，本节只写差异。

## 7. 范围

- 委派模式：one-shot，子 Agent 跑完即止，不接受后续消息。
- 子上下文：fork。子 Agent 看到父会话在继承点处的模型可见历史，在它之上继续；父会话当前在途的轮次不进入继承范围。
- 历史不复制：fork 只在 `session_forks` 记一个继承点，历史通过回放拼接父会话的消息；继承段只读。
- 两种模式并存：spawn 用于自包含任务，fork 用于建立在当前对话上下文上的子任务。DSH 用同一个工具名、由 provider 决定是否继承上下文（`dsh-tool-subagent/lib/index.js:337-346`）；本项目把两种模式拆成两个工具，让模型按任务性质选择。
- 与第一步共用：结算消息格式（§2.3）、结果投递与自动续轮（§3）、子 Agent 的 system prompt 装配（§4.1）、权限门（§4.3）、取消与预算与失败回灌（§6）。

## 8. 与 model 的通信契约

### 8.1 subagent_fork 工具定义

工具经 `tools/subagent-fork/registry.json` 注册，`name = subagent_fork`。

`description` 逐字采用 dsh 的 fork wording（来源 `dsh-tool-subagent/lib/index.js:339`），后接与第一步相同的运行时尾句（来源 `:384`）：

> Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes. The completion notice includes its final answer. This backend does not accept follow-up messages.

`parameters`：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | string | 否 | `Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.` |
| `description` | string | 是 | `A short (3-5 word) description of the delegated task, for display.` |
| `prompt` | string | 是 | `The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new.` |

`cwd` 与 `description` 的描述与第一步逐字相同；`prompt` 的描述不同（来源 `:340`）。执行后立即返回 `started subagent <id>`（来源 `:438`），不等待子 Agent 结束。

### 8.2 system prompt 段落

委派指引段由工具清单整体生成，对所有会话完全相同（来源 `dsh-tool-subagent/lib/index.js:509-518`）：

> Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run.

两个工具共享同一段名 `tool:subagent`，段落内容按工具集合整体生成，不按工具逐条输出；工具清单不随会话变化（§9.2），这段文案因此是静态的。

## 9. 子 Agent 构造

### 9.1 上下文

system prompt 装配、loop 引擎、事件隔离与第一步相同。差异在首轮上下文：模型看到的是「继承段 + 本次 task prompt」，而不是只有 task prompt。

继承段是父会话在继承点处的**模型可见历史**：父此前压缩过时，它是一份 checkpoint 加压缩点之后的父消息，而不是父的 transcript 原文。父会话在途轮次的消息不在其中。这一段逐字复用父会话的消息，不重新摘要、不改写；工具清单与 system prompt 与父会话一致时，这段前缀可命中 provider 的前缀缓存。

继承段只读：子 Agent 可以压缩它（吸收进本会话摘要），不能修改父会话的消息。

父会话尚无已完成轮次时继承段为空，子 Agent 从零开始，与 spawn 等价。

### 9.2 工具面

- 两个委派工具对所有会话都出现在 `payload.tools` 与 system prompt 里，不按会话 `kind` 裁剪：工具清单是请求前缀的一部分，裁剪会让继承段与前缀缓存全部失效。
- `subagent` 在子会话里仍在清单中，但执行时返回错误：spawn 只允许从主会话发起。
- `subagent_fork` 在所有会话可用，多层树由这条执行许可维持。
- 子 Agent 的其余工具与父轮次可见集一致；`toolFilter` / persona 不作为委派参数（与第一步相同）。

本项目不设委派深度上限：fork 的层数由 `subagent_fork` 的执行许可维持。dsh 的 subagent 服务默认 `maxDepth = 1`（`dsh-subagent/lib/index.js:2979`），并在触顶时注入停止委派的 runtime context（`dsh-tool-subagent/lib/index.js:519-529`），本项目不复刻该上限。

### 9.3 权限

fork 继承对话历史，但不继承工具、服务、scope 或权限：子 Agent 的权限门与第一步完全相同，scope 在启动时固定，`ask` 档自动拒绝。`inheritsParentContext` 只声明对话前缀继承，与工具、服务、scope、授权无关（来源 `dsh-tool-subagent/lib/index.js:331-334`）。

## 10. 继承点

fork 在创建子会话时写一行 `session_forks`：子会话是新建的 `kind = subagent` 会话，父会话是发起委派的会话，继承点取父会话最后一个已完成轮次。该值在 fork 时写死，父之后新增轮次或再次压缩都不改变子会话看到的历史。

继承点的字段定义、回放优先级与压缩吸收规则归 `session-tree.md`；本节只定义 fork 写入这个动作。
