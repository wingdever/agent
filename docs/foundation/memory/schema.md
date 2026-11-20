# 数据结构设计

支撑 agent-loop 在进程内运行。状态按会话分三处：会话事实在 store，实例运行态与每轮投递态在 `Agent` 实例上，跨会话的进程级闸门在 Runtime 容器上。落库数据与跨会话记忆不在本结构内。

真值口径：

- **冷数据以存储为准**：进程重启、查看或唤醒会话时，从 store 映射得到身份与历史。
- **运行中的会话以内存为准**：实例持有本会话的运行态与投递态，运行期不读第二份副本；轮次内的请求历史以 `RequestSpec.messages` 为准，该轮结束后由落库行承担真值。

树状关系：

```
AgentRuntime{ services, bootId, gates(activeSessions, compacting), registry{ agents[ sessionId -> Agent ], activity, selected, bare } }
Agent{ 身份, services, phase, inbox, planMode, todos, turn }
agent-loop{ request{ header, messages, config }, step{ response } }
```

## AgentRuntime（进程容器）

| 字段 | 含义 | 归属 |
|---|---|---|
| `services` | config / model / context / tools / skills / interactions / subagents / store / goals，同一进程内所有实例共享 | 注入 |
| `bootId` | 进程身份，压缩锁与 stale 判定用 | 进程 |
| `activeSessions` / `compacting` | 进程级闸门，按 `String(sessionId)` 键；比一轮活得久，可由非轮次路径（手动压缩）发起 | 进程 |
| `registry` | `AgentRegistry`，进程内唯一的实例索引 | 容器 |

容器不持有任何会话的投递态；两个会话同时跑轮次时，容器字段不变。

## AgentRegistry（实例索引）

| 成员 | 含义 |
|---|---|
| `instances` | `Map<String(sessionId), Agent>`，登记实例的索引 |
| `activity` | 登记会话的活跃时刻，`String(sessionId) -> 单调计数` |
| `selected` | 显式选中：一个实例，或空表示回到派生 |
| `bare` | 当前等待开启的 bare 会话实例 |

接口：`get(sessionId)`、`getOrCreate(sessionId)`、`has(sessionId)`、`list()`、`current()`、`setCurrent(agentOrSessionId)`、`touch(sessionId)`、`openBare()`、`dispose(sessionId)`、`createTransient(sessionId?)`。

- **复数与单数**：`get` / `getOrCreate` 是复数形态，凡指定会话的调用者（树内消息、中断、带 sessionId 的 RPC）都从这里取；`current()` 是单数形态，即「光标 agent」：不必指明就能与之交互的那个实例。
- **光标是派生值，不是记忆值**：`current()` 按固定优先级求值，不存「上次是谁」的副本。

### 光标求值

按顺序取第一个成立者：

1. **显式选中且仍存在**的非子代理实例（上一个带 sessionId 的轮次所选，或显式 `setCurrent`）。
2. **最近活跃的工作区会话**：`kind = "normal"` 的登记实例中 `activity` 最大者；子代理即使刚跑过也不参与。
3. **等待开启的 bare 会话**：`bare` 字段所指实例。
4. 以上都不成立时无光标。

- **子代理**：除非本次调用显式点名，否则默认光标不落在子代理上。被选中的子代理在下一次派生求值时被丢弃。
- **bare 会话**：每次 bare 轮由 `openBare()` 新建并替换上一个（替换时中断仍在跑的旧会话），光标指向它；丢弃显式选中时若它空闲则一并释放。
- **指针语义**：这些字段持有实例引用，不复制实例；同一个会话在任何时刻只有一个实例，光标、索引、正在跑的轮次指向它。
- **懒创建**：首次需要时创建，身份在创建瞬间从 store 读取（`sessionId` / `kind` / `parentSessionId` / `agentName` / `persist`）；不存在的会话不产生实例。
- **驻留**：创建后驻留到进程退出，不设空闲回收——inbox 是内存态，回收会丢未领取的输入。
- **销毁**：只在会话硬删时 `dispose`：先中断正在跑的轮次，再移出索引，若它是光标则清空光标。
- **光标更新**：带 sessionId 起轮次时选中该实例并记录活跃时刻；bare 轮新建 bare 会话并选中它。光标所指实例被硬删时丢弃该选择，按优先级重新派生，不清空为「无」。

## Agent（一个会话的运行态）

Agent 三段式构造函数：SharedServices 注入共享服务引用 → 构造函数的显式字段清单即实例状态的初始值 → 实例方法承载行为。新增实例状态必须出现在这份清单里。

| 字段 | 含义 | 归属 |
|---|---|---|
| `sessionId` / `kind` / `parentSessionId` / `agentName` / `persist` | 身份，来自 store、只读 | 注入 |
| `shared` 及各服务引用 | 共享服务 | 注入 |
| `gates` | 容器闸门（`activeSessions` / `compacting` / `bootId`）的只读引用 | 注入 |
| `phase` | `{ kind: "idle" }` 或 `{ kind: "running", abort: AbortController }`，并发唯一判据 | 运行时 |
| `inbox` | `{ nextTurn, nextStep }`，进程内输入队列，不落库 | 运行时 |
| `planMode` | `{ active, pendingExit, lastHeaderActive, notices }` | 运行时 |
| `todos` | turn 内 todo 投影 | 运行时 |
| `turn` | 当前 TurnState；轮内非 null，轮末置 null | 容器 |

接口：`beginTurn({ emit, autonomy, effort, activity, interactions })` 返回 `{ turn, abort, signal, finish }`；`enqueue(message, target)`；`claimNextTurn()` / `claimNextStep()`；`hasPending()`；`interrupt()`；`whenIdle()`；plan 态的 `setPlanMode` / `planPolicyActive` / `recordHeaderPlanMode` / `requestPlanExit` / `applyPlanExit` / `takePlanNotices`；todo 的 `setTodos` / `resetTodos`。

- **一个会话同一时刻最多一个 running**，第二个输入不报错，只改变去的队列。
- **`interrupt()` 只 abort**，不清 inbox、不杀后代；恢复由下一次输入新建控制器。

## TurnState（每轮投递态）

Agent.turn 持有的每轮投递状态，描述「这一轮把事件发去哪、按什么授权策略跑」。轮与轮之间没有共享语义，轮末失效。turn 级的数据容器（request / step / system / conv）不叫 TurnState，见下文 RequestSpec 与 StepState。

| 字段 | 含义 | 归属 |
|---|---|---|
| `emit` | 本轮唯一事件出口；`InteractionService` 从调用方实例的 `turn.emit` 取事件出口，不自存 | 注入 |
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

- `RequestSpec.messages` 是轮次内请求历史的唯一权威：pre-step 压缩就地改写它，model-call 追加 `ModelResponse`，tool-execute 追加 tool 结果，跨 step 累积，历史不另存副本。
- `RequestSpec.header` 与 `messages[0].content` 是同一事实的两个视角：pre-step 产出前者并写入后者；overflow 重试同时改写二者。权威在 `RequestSpec.header`。
- `RequestSpec` 的模型与工具配置在 turn 内固定，由 turn-start 与 resolve-target 的结果注入；`Agent.planMode.active` 是计划态的唯一副本，`RequestSpec.planActive` 是它在某一步的投影。
- `ModelResponse` 是本步响应的唯一权威；assistant message 是它的落库投影，只含 content 与 thought。`tool_calls` 与 `callIds` 按下标对齐，`callIds` 由落库 call 记录生成，工具执行阶段用它回写结果。
- 每个会话持有独立的实例，身份按 sessionId 索引；父子之间不共享任何运行态。子代理结算经父实例的 inbox 投递（父忙进 `nextStep`，父闲进 `nextTurn` 并唤醒），领取后以 user 消息落库。
- `TurnState` 只描述投递态；请求与步骤数据分别由 `RequestSpec` 与 `StepState` 持有，三者不互相嵌套。
- `contextMessages` 只进 `RequestSpec.messages`，不落库；输出翻译只发事件，不进 `messages`、不落库。
- plan 态、todo 投影、inbox 队列都只有实例上这一份；`core/plan-mode.js` 只留 POLICY 文本，`lib/todo-state` 只读写传入实例的字段。

## 介质边界

- 落库：turn / step / message / call 记录、session 级 system prompt、assistant message（content / thought）、inbox 领取后的 user 消息。
- 仅内存：`Agent` 的 `phase` / `inbox` / `planMode` / `todos`、`TurnState` 投递态、`RequestSpec` 与 `ModelResponse` 整体（含其中未落库段与 `header` / `planActive`）、`translatedUser`、容器的 `activeSessions` / `compacting` / 光标的派生输入（`activity` / `selected` / `bare`）。
- 派生视图：`callIds` 与 `tool_calls` 的对齐关系、`TurnState.steps` / `toolsUsed` 计数、`RequestSpec.planActive`、agent 的 `agentName`。

## 进程退出

实例与容器都不落库：未领取的 inbox 输入、未启用的光标、闸门状态随进程退出丢弃；重新唤醒同一会话时从 store 重建身份与历史，实例按初始值重新构造。
