# agent 实例

## 1 定义

Agent 是会话级运行时实例：一个会话在进程内对应一个 Agent，跨轮次常驻，直到会话被硬删或进程退出。会话事实（消息、轮次、树关系）存放在 store；实例只持有进程内运行态，经 sessionId 与 store 关联。

`AgentRegistry` 是进程内唯一的实例索引，按 `String(sessionId)` 存取。对运行态的任何读取都经注册表，不另设副本。

**复数与单数**是两个不同的入口，不要混用：

- **复数（registry）**：凡指定会话的调用者——树内消息、中断、带 sessionId 的 RPC、父级投递结算——都按 sessionId 取实例。
- **单数（光标）**：`registry.current()` 返回「光标 agent」——未指定会话时默认选中的那个实例。它是派生的指针，按优先级求值：显式选中且仍存在的非子代理实例 → 最近活跃的工作区会话（`kind = "normal"`）→ 等待开启的 bare 会话 → 无。子代理除非显式点名，否则不成为默认光标。

## 2 状态归属

原则：**一份真值 + 按 sessionId 索引 + 唯一访问器**。同一份状态不出现第二个副本。

| 类别 | 存放 | 生命周期 | 访问入口 |
|---|---|---|---|
| 会话事实 | store | 持久 | store 操作面 |
| 实例运行态 | 实例 | 实例存续 | `AgentRegistry.get(sessionId)` |
| 进程级闸门 | 容器字段（key=sessionId） | 进程 | 实例的 `gates` 只读引用 |
| 每轮投递态 | 实例的 `turn` 子对象 | 单轮 | 实例自身 |

- **会话事实**：消息、轮次、步骤、调用、压缩、fork 继承点、委派关系。它们天然可共享读，多个 agent 并发运行互不阻断。
- **实例运行态**：`phase`、abort 控制器、inbox、本会话计划态、本会话 todo 投影。同一会话的任何读者（控制面、压缩、RPC）都通过注册表拿到同一个实例。
- **进程级闸门**：`activeSessions` 与 `compacting`，随容器存活。压缩可能由非运行路径发起（RPC 手动压缩），必须比「会话是否正在跑一轮」活得久，因此不放实例；实例只读引用。
- **每轮投递态**：`emit`、`autonomy`、`effort`、`activity`、`interactions`，以及本轮计数。它们描述「这一轮把事件发去哪、按什么授权策略跑」，轮与轮之间没有共享语义，轮末失效。

两个会话同时跑各自的轮次时，只有投递态不同，事实与闸门都是同一份。

## 3 实例内容

```
Agent {
  // 身份：只读，来自 store
  sessionId        number
  kind             "normal" | "subagent"
  parentSessionId  number | null
  agentName        string              // 从根起的斜杠路径，根为 "lead"
  persist          boolean             // false 表示 bare 模式

  // 共享服务引用与进程闸门引用
  shared  config  model  context  tools  skills  store  goals  subagents  interactions
  gates   { activeSessions, compacting, bootId }

  // 运行态
  phase     { kind: "idle" } | { kind: "running", abort: AbortController }
  inbox     { nextTurn: Message[], nextStep: Message[] }
  planMode  { active, pendingExit, lastHeaderActive, notices }
  todos     Todo[]

  // 每轮投递态，轮内非 null，轮末置 null
  turn  { emit, autonomy, effort, activity, interactions, steps, toolsUsed, startedAt }
}
```

`context` 是共享服务：它无状态，所有方法显式接收 sessionId。`InteractionService` 也是共享服务：一个实例服务所有会话，事件出口与授权档位从调用方的 `turn` 取，pending 表按 id 记录所属会话。

## 4 构造

三段式构造函数，顺序固定：

1. **SharedServices**：进程内共享的服务引用，组合根创建一次，所有实例共享同一组。
2. **AgentState**：实例运行态字段的初始值，即 `Agent` 构造函数里的显式字段清单。这里是「哪些状态属于实例」的清单，新增状态必须在此出现。
3. **Agent**：把前两段装进实例，附上行为方法。

显式赋值清单本身就是隔离契约：读一个不存在的字段会报错，而不是沿原型链回落到别的实例。子代理也走这条构造，不靠原型链伪造出第二个光标。

## 5 生命周期

- **懒创建**：首次需要该会话的实例时创建——收到输入、控制面要寻址、RPC 要设置会话态、要查询运行状态。身份在创建瞬间从 store 读取。
- **驻留**：创建后驻留到进程退出，不设空闲回收。inbox 是内存态，回收会丢未领取的输入。
- **销毁**：会话硬删时销毁（先中断在跑的轮次）；软删时保留实例，但中止正在跑的轮次。
- **冷恢复**：store 中存在的会话可以直接实例化，身份与历史由 store 提供。进程重启后子会话同样按需实例化，因此「向一个已存在但不在内存里的子会话发消息」可以正常唤醒它。
- **光标**：带 sessionId 起轮次时选中该实例并记一次活跃；bare 轮新建 bare 会话并指向它。所指实例被硬删时丢弃选择、按优先级重新派生。光标只持有引用，不复制实例。

## 6 并发

- 同一会话同一时刻最多一个 `running` 轮次；`phase` 是唯一判据。同一会话的第二个输入不启动新轮次，也不报错，而是进 inbox 的 `nextTurn`。
- 不同会话可以同时 `running`，互不影响：投递态在各自实例上，订阅者与拒绝策略都不共享字段。
- 「这个会话是否在跑」的查询是 `registry.get(id)?.phase.kind === "running"`，不再维护独立的活跃集合用于判定。
- 轮次开始与结束只改本实例的 `phase` 与 `turn`，不改进程级字段。

## 7 bare 模式

`mode=bare` 使用不登记的临时实例：`persist=false`、`sessionId=null`，运行态只在该实例存活期间有效。它与其他实例共用同一套轮次语义，只是不落库、不进索引。进程内保留最近一个 bare 会话作为「等待开启」的缺省：有工作区会话在用时，光标优先落在工作区会话，bare 会话退居其后；没有工作区会话时，无名调用落到它上面。无 store 且未登记的会话同样跑在临时实例上。

## 8 接口

- `AgentRegistry` 构造 `({ shared, gates })`；`get(sessionId)`；`getOrCreate(sessionId)`；`has(sessionId)`；`list()`；`current()`；`setCurrent(agentOrSessionId)`；`touch(sessionId)`；`openBare()`；`dispose(sessionId)`；`createTransient(sessionId?)`。
- `Agent`：`beginTurn({ emit, autonomy, effort, activity, interactions })` 返回 `{ turn, abort, signal, finish }`；`enqueue(message, target)`；`claimNextTurn()`；`claimNextStep()`；`hasPending()`；`interrupt()`；`whenIdle()`；`running()`；plan 态与 todo 的读写方法。
- 进程容器：`chat(ctx)` 按 sessionId 或光标取实例后起一轮；`get(sessionId)` / `getOrCreate(sessionId)` / `list()` 转发注册表；`compactSession(opts)` 同经实例。
