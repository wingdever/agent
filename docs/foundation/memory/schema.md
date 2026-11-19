# 数据结构设计

支撑 agent-loop 在进程内运行。结构只存在于单个 turn 的执行期间，turn 结束后释放。落库数据、跨会话记忆不在本结构内。

树状关系:

```
runtime{ services, agents[ agent{ phase, inbox, planMode, todos, turn{ emit, autonomy, effort, activity, interactions, steps, toolsUsed, startedAt } } ] }
agent-loop{ request{ header, messages, config }, step{ response } }
```

## RuntimeState（进程）

| 字段 | 含义 | 归属 |
|---|---|---|
| `services` | config / model / context / tools / skills / interactions / subagents / store / goals | 注入 |
| `agents` | 按 sessionId 索引的 Agent 实例集合；由 AgentRegistry 唯一存取 | 容器 |

## AgentState（一个 agent 的运行态清单）

Agent 三段式构造的第二段：实例运行态字段的显式初始值清单（docs/agents/agent-instance.md §4）。它不是独立流转的数据对象；会话事实在 store，进程级闸门（压缩）在独立 Map，二者都不在此列。

| 字段 | 含义 | 归属 |
|---|---|---|
| `sessionId` / `kind` / `parentSessionId` / `agentName` / `persist` | 身份，来自 store、只读 | 注入 |
| `phase` | `{ kind: "idle" }` 或 `{ kind: "running", abort: AbortController }`，并发唯一判据 | 运行时 |
| `inbox` | `{ nextTurn, nextStep }`，进程内输入队列，不落库 | 运行时 |
| `planMode` / `todos` | 本会话计划态与 turn 内 todo 投影 | 运行时 |
| `turn` | 当前 TurnState（每轮投递态）；轮内非 null，轮末置 null | 容器 |

## TurnState（每轮投递态）

Agent.turn 持有的每轮投递状态，描述「这一轮把事件发去哪、按什么授权策略跑」。轮与轮之间没有共享语义，轮末失效。turn 级的数据容器（request / step / system / conv）不叫 TurnState，见下文 RequestSpec 与 StepState。

| 字段 | 含义 | 归属 |
|---|---|---|
| `emit` | 本轮唯一事件出口 | 注入 |
| `autonomy` / `effort` / `activity` | 本轮授权档位、推理档位、活动枚举 | 注入 |
| `interactions` | 本轮交互服务句柄 | 注入 |
| `steps` / `toolsUsed` / `startedAt` | 本轮计数与开始时间 | 累积 |

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
- 每个 agent 持有独立的运行态清单（`createAgentState` 的返回值），按 sessionId 索引；父子之间不共享。子 agent 结算经父的 `inbox.nextStep`（父忙）或 `inbox.nextTurn`（父闲）投递，领取后以 user 消息落库。
- `TurnState` 只描述投递态；请求与步骤数据分别由 `RequestSpec` 与 `StepState` 持有，三者不互相嵌套。
- `contextMessages` 只进 `RequestSpec.messages`，不落库；输出翻译只发事件，不进 `messages`、不落库。

## 介质边界

- 落库：turn / step / message / call 记录、session 级 system prompt、assistant message（content / thought）、inbox 领取后的 user 消息。
- 仅内存：`RequestSpec` 与 `ModelResponse` 整体（含其中未落库段与 `header` / `planActive`）、`AgentState` 运行态清单与 `inbox` 队列、`TurnState` 投递态、`translatedUser`、pending 退出态。
- 派生视图：`callIds` 与 `tool_calls` 的对齐关系、`TurnState.steps` / `toolsUsed` 计数、`RequestSpec.planActive`、agent 的 `agentName`。
