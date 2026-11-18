# 数据结构设计

支撑 agent-loop 在进程内运行。结构只存在于单个 turn 的执行期间，turn 结束后释放。落库数据、跨会话记忆不在本结构内。

树状关系:

```
runtime{ services, emit, agents[ agent{ lifecycle, steering, turn{ input, pending, system, plan, request{ header, messages, config }, step{ response } } } ] }
```

## RuntimeState（进程）

| 字段 | 含义 | 归属 |
|---|---|---|
| `services` | config / model / context / tools / skills / interactions / subagents / store / goals | 注入 |
| `agent` | 进程内运行时句柄：autonomy / effort / activity、turn 占用表、压缩门 | 注入 |
| `emit` | 本 turn 唯一事件出口 | 注入 |
| `agents` | 按 sessionId 索引的 AgentState 集合；任务 / 取消 / steering / 唤醒表按同一键归位 | 容器 |

## AgentState（一个 agent）

每个 agent 一份，按 sessionId 索引；父子 agent 不共享数据块。

| 字段 | 含义 | 归属 |
|---|---|---|
| `sessionId` | agent 所属会话 id，运行时索引的键 | 注入 |
| `path` | 从根起的斜杠路径，根为 lead；由 subagent 关联边推导 | 派生 |
| `scope` | 启动时固定的权限范围；需要审批的操作一律拒绝 | 注入 |
| `lifecycle` | `{ task, controller, settled, waking }`：后台轮次、独立取消通道、结算是否已投递、唤醒中标记 | 运行时 |
| `steering` | 待注入下一次模型请求的消息队列 | 运行时 |
| `childContexts` | agent 被唤醒续跑时复用的父轮次工具清单与事件出口快照 | 运行时 |
| `turn` | 当前 TurnState；agent 每轮各一份 | 容器 |

## TurnState（一轮）

### 输入

| 字段 | 含义 |
|---|---|
| `session` | `{ id, persist }`；`persist = !!(sessionId && store)` |
| `input` | `{ messages, references, cwd, source, contextMessages }`；`contextMessages` 不落库 |
| `toolNames` | 本轮可用工具名 |
| `autonomy` / `activity` | supervised\|autonomous；plan-mode\|bare-chat\|… |

### 派生与累积

| 字段 | 含义 | 归属 |
|---|---|---|
| `cwd` | 输入 cwd 基于 resolveCwd 解析后的绝对路径 | 派生 |
| `translateCfg` | 翻译配置 | 派生 |
| `system` / `systemIsNew` | session 级 system prompt；首轮装配并落库，后续轮复用 | 落库投影 |
| `catalogMsg` | skill 目录消息；首轮作为 user 消息落库 | 落库投影 |
| `translatedUser` | 输入翻译结果，写入 `request.messages` 的 user 消息后落库；输出翻译只发事件 | 派生 |
| `pending.user` / `pending.refs` | 本轮用户输入与 @引用消息；首步落库 | 派生 |
| `pending.turnMessages()` | 自动压缩重建历史时追加的尾部消息；首步落库后返回空 | 派生 |
| `plan.active` | session 级计划态，由 plan-mode 模块持有 | 外部权威 |
| `turn.row` | turn 记录 | 落库投影 |
| `turn.startedAt` | 本轮开始时间 | 派生 |
| `turn.stepSeq` | step 序号分配计数器 | 权威 |
| `turn.steps` / `turn.toolsUsed` | 已发起 step 数 / 已执行工具数 | 累积 |
| `turn.status` / `reason` / `errorText` | 终止原因与错误信息 | 累积 |
| `request` | 本轮 RequestSpec；请求字段的唯一所有者 | 容器 |
| `step` | 当前 StepState；turn 开始时为 null | 容器 |

## StepState（一步）

| 字段 | 含义 | 归属 |
|---|---|---|
| `row` | step 记录 `{ id, turn_id, seq, status }` | 落库投影 |
| `seq` | 取自 `turn.stepSeq` | 派生 |
| `messageSeq` | 本 step 内消息序号；system / catalog / user / notice / assistant / tool 共用 | 权威 |
| `response` | 本步 ModelResponse，归一化响应 | 权威 |
| `assistantMsg` | assistant message 记录，`response` 的落库投影 | 落库投影 |
| `callIds` | call 记录 id，下标与 `response.tool_calls` 对齐 | 落库投影 |
| `userPersisted` | 首步 user / catalog 是否已落库 | 派生 |
| `status` | running / succeeded / failed | 落库投影 |

## RequestSpec（完整请求）

turn 内唯一的请求数据条目，由 turn-start 与 resolve-target 的结果一次性建立，可直接交给模型通信层使用。pre-step 每步改写其上下文字段，overflow 重试时在同一条目上修订。

| 字段 | 含义 | 归属 |
|---|---|---|
| `header` | 本次请求的 system 文本 = `system` + plan POLICY，写入 `messages[0].content` | 权威 |
| `messages` | 完整请求历史，跨 step 累积；tool 结果也追加到这里 | 权威 |
| `planActive` | 生成 header 时观察到的 plan 态 | 派生 |
| `model` / `baseUrl` / `apiKey` | 目标模型与连接凭据 | 注入 |
| `effort` / `stream` | 推理档位与流式开关 | 注入 |
| `selected` / `toolDefs` | 选中的工具及其定义 | 注入 |
| `permissions` / `fsPolicy` | 工具权限与路径策略 | 注入 |
| `sessionId` | 请求标识 | 注入 |
| `onEvent` | 事件出口 | 注入 |

## ModelResponse（归一化响应）

一次模型请求的完整响应，仅内存。流式读取时先累积进临时累加器，收尾统一归一化为本条目。

| 字段 | 含义 | 归属 |
|---|---|---|
| `content` | 文本回复 | 权威 |
| `reasoning_content` | 推理内容 | 权威 |
| `tool_calls` | 工具调用列表 | 权威 |
| `finish_reason` | 终止原因，传输层元数据，不进后续请求的消息 | 权威 |
| `usage` | 标准化用量 | 权威 |
| `role` | 固定为 assistant | 派生 |

落库投影为 assistant message：`content` 写入 content、`reasoning_content` 写入 thought，连同 `stepId` / `seq` 构成一条消息记录。`finish_reason` 与 `usage` 不落库，只用于终止判定、token anchor 与事件上报。

## 所有权与派生

- `RequestSpec.messages` 是请求历史的唯一权威：pre-step 压缩就地改写它，model-call 追加 `ModelResponse`，tool-execute 追加 tool 结果，跨 step 累积，历史不另存副本。
- `RequestSpec.header` 与 `messages[0].content` 是同一事实的两个视角：pre-step 产出前者并写入后者；overflow 重试同时改写二者。权威在 `RequestSpec.header`。
- `RequestSpec` 的模型与工具配置在 turn 内固定，由 turn-start 与 resolve-target 的结果注入；`plan.active` 由 plan-mode 模块持有，`RequestSpec.planActive` 是它在某一步的投影。
- `ModelResponse` 是本步响应的唯一权威；assistant message 是它的落库投影，只含 content 与 thought。`tool_calls` 与 `callIds` 按下标对齐，`callIds` 由落库 call 记录生成，工具执行阶段用它回写结果。
- 每个 agent 持有独立的 `AgentState`，按 sessionId 索引；父子之间不共享数据块，子 agent 结算以 user 消息回灌父会话，steering 在下次模型请求前注入 `RequestSpec.messages`。
- `turn.stepSeq` 分配 step 序号，`StepState.seq` 取自它；`turn.steps` 统计已发起的请求数。
- `contextMessages` 只进 `RequestSpec.messages`，不落库；输出翻译只发事件，不进 `messages`、不落库。

## 介质边界

- 落库：turn / step / message / call 记录，session 级 system prompt，assistant message（content / thought）。
- 仅内存：`RequestSpec` 与 `ModelResponse` 整体（含其中未落库段与 `header` / `planActive`）、`AgentState` 整体、`translatedUser`、`plan.active` 及 pending 退出态、`translateCfg`、`emit`。
- 派生视图：`callIds` 与 `tool_calls` 的对齐关系、`turn.steps` / `toolsUsed` 计数、`RequestSpec.planActive`、agent 的 `path`。
