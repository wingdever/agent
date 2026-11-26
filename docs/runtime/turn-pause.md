# turn 暂停（turn-pause）

## 范围

本文件定义「一键暂停当前 turn」：模型返回后，先不执行这一批工具，把 turn 停在工具执行前；用户继续时再执行，用户停止时结束本轮。

它不定义：

- 按单个工具调用暂停、跳过或逐条确认；
- 工具执行中的强制挂起；
- 跨进程重启后的原地继续；
- 完整 session recovery。

pause 是运行时控制，不是审批。审批仍然由 `tool-execute` 的既有权限门负责；pause 只决定“这一批工具现在要不要开始”。

## 1 语义

### 1.1 turn 级，不是 call 级

暂停的粒度是**一个 turn 的一个 step**：

- 一次暂停挡住整个工具批次；
- 继续时整批执行，不提供“跳过第 2 个调用”；
- 不改变单个工具的审批、参数校验和执行顺序。

### 1.2 只在工具批次前生效

暂停点固定在 `model-call` 之后、`tool-execute` 之前：

```text
model-call
  ├─ 没有 tool_calls            → decide-next
  ├─ 有 tool_calls，未请求暂停   → tool-execute
  └─ 有 tool_calls，已请求暂停   → tool-pause →（继续）→ tool-execute
```

模型返回没有 `tool_calls` 时，turn 本来就会结束，没有可暂停的工具批次。

### 1.3 不打断模型和工具

pause 不是 abort：

- 模型正在流式返回时点暂停：不打断模型，等完整响应落库后再停；
- 工具已经在执行时点暂停：不打断工具，当前批次继续跑完；暂停请求留到下一次模型返回后的工具批次前生效；
- 如果之后模型不再调用工具，turn 自然结束，暂停请求不再有意义。

要立刻停止，用 cancel，不是 pause。

### 1.4 暂停不是终态

暂停中的 turn 仍然是活的：

- 可以继续；
- 可以停止；
- 不能自动开下一轮；
- 不能自动执行待处理工具。

## 2 节点与控制流

新增 `tool-pause` 节点，注册在 `core/loops/nodes/tool-pause/`：

```json
{
  "id": "tool-pause",
  "next": "tool-execute",
  "type": "core",
  "hooks": { "before": [], "after": [], "onError": [] },
  "entry": "run.js"
}
```

`model-call` 在写 assistant 消息和 calls 之后，根据 `agent.turn.pause.requested` 选择 next：

- 有 `tool_calls` 且请求了暂停 → `tool-pause`；
- 有 `tool_calls` 且未请求暂停 → `tool-execute`；
- 没有 `tool_calls` → `decide-next`。

`tool-pause` 的职责只有三件：

1. 把当前 turn 标记为 `paused`；
2. 确认这一批 calls 都还是 `not-started`；
3. 等待 `resume` 或 `cancel`，继续时返回 `next: "tool-execute"`。

它不调用任何工具，不写 tool result，不改 assistant 消息。

## 3 状态机

```text
idle
  └─ turn-start → running
       ├─ requestPause() → running + pauseRequested
       │    └─ 到达 tool-pause → paused
       │         ├─ resumeTurn() → running → tool-execute
       │         └─ cancel → cancelled
       └─ 正常结束 → succeeded / failed
```

字段含义：

| 状态 | 含义 |
|---|---|
| `running` | 正常执行；`pauseRequested=false` |
| `running + pauseRequested` | 已收到暂停请求，但还没到工具批次边界 |
| `paused` | 已停在 `tool-pause`，没有工具在执行 |
| `cancelled` | 用户停止，turn 结束；不是暂停 |

`pauseRequested` 是 turn 内的内存标记，v1 不落库；`paused` 是可观察状态，v1 通过 `turn.state` 与控制事件暴露。跨进程恢复见 §7。

## 4 控制 API

### 4.1 Agent

| 方法 | 行为 |
|---|---|
| `requestPause()` | 当前有 live turn 时置 `turn.pause.requested=true`，返回 `true`；空闲或无 turn 返回 `false` |
| `resumeTurn()` | 只有 `paused` 时有效；清除暂停、恢复 running，resolve 等待者，返回 `true` |
| `pauseAt(node)` | `tool-pause` 内部调用；持久化暂停状态并等待 resume / abort |
| `interrupt(reason, cause)` | 复用现有取消；暂停等待者以 abort 结束，turn 走 cancel 语义 |

`turn.pause` 形状建议：

```js
{
  requested: false,
  active: false,
  node: null,        // "tool-execute"
  resolve: null,
  reject: null
}
```

### 4.2 RPC

| 名称 | 类型 | 用途 |
|---|---|---|
| `turn.state` | read | 返回当前 turn 的执行状态 / `pauseRequested` / `paused` |
| `turn.pause` | write | 请求暂停当前 turn；有 live turn 时返回 `{ requested: true }` |
| `turn.resume` | write | 从 paused 继续；非 paused 返回 `false` |
| `turn.cancel` | write | 停止当前 turn；paused 和 running 都适用 |

参数用 `session_id` 定位；没有 live turn 时返回 `false`，不创建新 turn。`turn.pause` 是幂等的：重复调用不改变状态。`turn.state` 也用于 SSE 断线后重建按钮状态。

### 4.3 UI

- 运行中显示一个“暂停”按钮；点击后按钮变为“将在当前步骤结束后暂停”，不假装已经停住。
- 到达 `paused` 后显示：
  - “已暂停在工具执行前”；
  - 待执行工具列表（名称、参数摘要）；
  - “继续执行”和“停止本轮”。
- 不提供按工具的“跳过 / 只跑这个 / 单独确认”按钮。
- 继续之后，原有的审批卡片仍按原逻辑出现；pause 不替代审批。

## 5 与现有机制的关系

- **model-call**：assistant 消息与 calls 必须先落库，再进入 `tool-pause`。如果两者不是同批提交，pause 点会出现“消息在、call 不在”的不可修复缺口。
- **tool-execute**：pause 位于参数校验、审批、执行之前；继续后走原有完整流程。
- **审批**：pause 是批次级粗门，审批是调用级细门；v1 不合并。
- **inbox**：暂停中收到的新用户消息进 `nextTurn`，不自动继续；`nextStep` 消息留在队列，等恢复后的 step 边界领取。
- **goal**：暂停中的 turn 仍是 running，goal driver 不会开下一轮；暂停不是 goal 的 blocked / paused 状态。
- **subagent**：暂停中的父 turn 不结算；子代理已经产生的消息留在 inbox / store，等父继续后再处理。
- **cancel**：取消会 abort 当前模型请求或工具，和 pause 的“等当前动作结束”不同。

## 6 边界

本期做：

- 一键暂停 live turn；
- 整批工具停在执行前；
- 继续 / 停止；
- 暂停状态在 UI 可见；
- 重启后不自动执行 pending 工具。

本期不做：

- 单个工具的暂停 / 跳过 / 逐条确认；
- 工具执行中的挂起；
- 暂停中自动开新 turn；
- 重启后原地执行 pending tools；
- 暂停状态与审批卡片合并；
- 多客户端同时控制同一个 paused turn。

## 7 分期

### v1：进程内暂停

- `tool-pause` 节点、`requestPause` / `resumeTurn` / `pauseAt`；
- `turn.pause` 内存状态；
- `turn.pause` / `turn.resume` / `turn.cancel` RPC；
- UI 一个暂停按钮 + 继续 / 停止；
- 不落 `turn_runtime`，不保证进程重启后还能原地继续。

### v2：暂停状态持久化

- 写 `turns.status='paused'` 与 `turn_runtime.status='paused'`；
- 记录 `next_node='tool-execute'`，`pending_calls` 全部 `not-started`；
- 重启后恢复为 paused，不自动执行工具；
- 继续时重建 `tool-execute` 所需的调用参数，按安全点续跑；
- 这时才需要 `store.flush()` / 事务，保证 assistant 消息与 calls 同批落库。

### v3：并入 session recovery

- paused turn 作为恢复分类中的“可继续安全点”；
- 与 `session_lease`、`turn_runtime`、`session_inbox` 对齐；
- 仍不自动重放任何可能产生副作用的调用。

## 8 测试

- 模型返回 2 个 tool call，暂停后两个都没执行；继续后各执行一次。
- 模型流式输出中点暂停：响应完整落库后才进入 paused，不截断 assistant 消息。
- 工具批次执行中点暂停：当前工具不被打断，下一批工具前暂停。
- 暂停后取消：没有工具执行，turn 结束，`turn:end` 有取消原因。
- 模型返回无 tool call：暂停请求无效，turn 正常结束。
- 暂停后继续：审批仍然触发；审批拒绝时整批按原语义处理。
- 连续点两次暂停：第二次幂等，不产生第二个 paused 状态。
- 暂停中发新用户消息：进入 `nextTurn`，不自动继续，不丢消息。
- 重启：v1 不要求原地继续；v2 要求保持 paused 且不自动执行工具。
