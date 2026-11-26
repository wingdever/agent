# turn 暂停（turn-pause）

## 范围

本文件定义「暂停当前 turn」：一轮正在运行时，用户可以发出暂停请求；请求在下一个可暂停点生效，这一轮停住、不再推进；用户继续时这一轮从停住处继续运行。

暂停是**可恢复的打断**，不是停止。停止 / 硬取消 / 丢弃本轮 / 重试本轮不在本文件范围，运行时仍然只有既有的 `interrupt()`（abort 模型请求与工具、结束本轮），它不属于暂停语义。

本文件不定义：按单个工具调用暂停或跳过、工具执行中的强制挂起、暂停中自动开新 turn、多客户端同时控制同一个暂停轮次。

## 1 语义

### 1.1 两个可暂停点

暂停请求只在下面两个位置生效：

| 可暂停点 | 位置 | 停住的是 | `pausedAt` |
|---|---|---|---|
| 工具执行前 | `model-call` 返回之后、`tool-execute` 之前 | 这一批工具全部不执行 | `before-tools` |
| 模型请求前 | `pre-step` 之后、`model-call` 之前 | 下一次模型请求不发出 | `before-model` |

```text
pre-step ──(暂停请求?)──→ 停：before-model（继续 → model-call）
   │
   ▼
model-call
   ├─ 没有 tool_calls            → decide-next（本轮照常结束，暂停请求作废）
   ├─ 有 tool_calls，未请求暂停   → tool-execute
   └─ 有 tool_calls，已请求暂停   → 停：before-tools（继续 → tool-execute 整批原样执行）
```

模型返回没有 tool_calls 时，本轮本来就要结束，暂停请求作废并清除暂停标记，不把一轮已经收尾的 turn 停在中间。

### 1.2 暂停请求是意图，等到可暂停点才生效

- 模型请求进行中点暂停：不打断这次请求；等它返回后，有 tool_calls 就停在 `before-tools`，没有 tool_calls 就让本轮照常结束。
- 工具批次执行中点暂停：不打断正在执行的工具；本文件只设两个可暂停点，工具批次内部不设检查点，暂停请求留到下一次模型返回后的 `before-tools` 生效。
- 请求与生效是两件事：请求期间 UI 显示「将在当前动作结束后暂停」，到达可暂停点后才真正停住。

### 1.3 暂停不是终态

暂停中的 turn 仍然是活的，只是不再推进：

- 可以继续；
- 不能开新轮（同一会话的开轮被拒绝，见 §2.1）；
- 不能自动执行待处理工具；
- goal 自动续轮被立即撤除，继续也不会自动恢复（§5）。

### 1.4 继续不重跑模型

继续时从停住处接着走，**不重新请求模型**：

- `before-tools`：`tool-execute` 整批原样执行，调用与参数使用暂停前模型返回的那一批。
- `before-model`：直接进入 `model-call`，`pre-step` 不重跑。

继续时如果用户输入区有内容，这条内容作为 steer 进入下一步的请求；没有内容就单纯继续。请求里的消息顺序是 `assistant(tool_calls) → tool(tool_result) → user(steer)`。

### 1.5 节点落点

| 节点 | 位置 | 职责 |
|---|---|---|
| `turn-pause` | `pre-step` 的唯一后继 | 判定本次暂停点、调用 `pauseAt` 挂住、继续后按暂停点分派到 `tool-execute`（`before-tools`）或 `model-call`（`before-model`） |
| `resume-step` | 恢复续跑的入口 | 只用于关闭应用后重启的续跑：从存储重载被暂停 step 的 assistant 消息与 `pending` 调用，交给 `tool-execute` |

`model-call` 在写库之后检查暂停请求：有 tool_calls 走 `turn-pause`，没有就清除请求并照常进入 `decide-next`。`pre-step` 在检查点前同样把暂停请求分派给 `turn-pause`。两个节点的 `next` 都是缺省值，实际去向由节点返回的 `next` 决定。

## 2 状态机

### 2.1 进程内相位

实例的相位（`agent.phase`）取 `idle` / `running` / `paused` 三值：

```text
idle ──beginTurn──→ running ──到达可暂停点──→ paused ──继续──→ running(/tool-execute 或 /model-call)
  ▲                    │                        │
  └──── finishTurn ────┴──── finishTurn ────────┘
```

- `running()` 只表示正在执行；`inTurn()` 表示这一轮还活着（`running` 或 `paused`）。
- `beginTurn` 要求 `!inTurn()`：暂停中的会话不能再开一轮。
- `finishTurn` 无论从哪个相位收尾都回到 `idle`。
- 忙碌判断（新输入入队、`whenIdle` 等待、中断）一律按 `inTurn()`。

### 2.2 暂停标记

暂停请求与会话入队一样，是 turn 内的状态，形状：

```js
{ requested: false, active: false, node: null, pausedAt: null, resolve: null }
```

- `requested`：已请求、尚未生效；
- `active`：已停住，等待继续；
- `pausedAt`：停在哪一处（`before-tools` / `before-model`）；
- `resolve`：等待继续的 resolve。

`requested` 与 `active` 都是内存状态，运行期间不写数据库。

## 3 控制 API

### 3.1 Agent

| 方法 | 行为 |
|---|---|
| `requestPause()` | 有 live turn 时置 `pause.requested=true`，返回 `true`；空闲返回 `false` |
| `pauseAt(pausedAt)` | 只有在新一轮暂停标记尚未置位时有效：清 `requested`、置 `active`、记 `pausedAt`、进入 `paused` 相位、等待继续 |
| `resumeTurn()` | 只有 `paused` 相位有效：清 `active`、回到 `running`、resolve 等待者，返回 `true` |
| `inTurn()` | `phase.kind` 为 `running` 或 `paused` |

暂停时立即对 goal 调用 `disarm()`，不改变 goal 本身（phase 仍为 `active`，轮数不变）。

### 3.2 RPC

| 名称 | 类型 | 用途 |
|---|---|---|
| `turn.state` | read | 返回当前 turn 的相位、暂停点、下一步节点与待执行工具 |
| `turn.pause` | write | 请求暂停；没有 live turn 时返回 `false` |
| `turn.resume` | write | 从暂停继续；可带一条 steer 消息 |

参数用 `session_id` 定位。不提供 `turn.cancel`：停止 / 硬取消不是暂停语义。

`turn.state` 返回：

```json
{
  "sessionId": 12,
  "turnId": 340,
  "phase": "paused",
  "pausedAt": "before-tools",
  "nextNode": "tool-execute",
  "pendingCalls": [{ "callId": "call_abc", "name": "read", "arguments": "{...}" }]
}
```

`pendingCalls` 读数据库：`calls.status='pending'` 且属于当前未结束的 turn；其它相位返回空数组。

### 3.3 UI

- 运行中：composer 的发送按钮变为「暂停」，点击后变为「将在当前动作结束后暂停」。
- 到达暂停点：消息流里出现暂停卡片；`before-tools` 列出待执行工具（名称、参数摘要），`before-model` 显示下一步是模型请求；卡片只提供「继续」。
- 继续：若输入区有内容，先作为 steer 入队再继续；否则直接继续。

## 4 跨进程继续

### 4.1 快照

暂停状态只在关闭应用时写入快照；运行期间不写任何数据库。

| 存储 | 内容 |
|---|---|
| `snapshots` 表 | 一行一个会话：`session_id`、`created_at`。它是「启动时值得读快照」的索引 |
| `data/snapshots/<session>.json` | `{ state, pausedAt, nextStep }`，其中 `nextStep` 只含尚未领取的队列条目 |

`snapshots` 表由快照模块自己建表（`CREATE TABLE IF NOT EXISTS`），通用存储层不提供快照专属操作。

### 4.2 写

启动路径的 `before-quit` 钩子在关闭存储之前，遍历进程内登记的实例：

- 只写 `state='paused'` 的会话；`running` 或 `idle` 的会话不写（运行中关闭按未完成处理，不承诺恢复）；
- 先写快照文件，再插入 `snapshots` 行；
- 快照文件写入 `pausedAt` 与未领取的 `nextStep` 条目。

### 4.3 读

启动时读 `snapshots` 表中的每一行：

1. 读对应快照文件；
2. 删除该行（读到即清，文件保留，下次关闭覆盖）；
3. 按快照恢复该会话为 `paused` 相位，恢复 `pausedAt` 与未领取的 `nextStep` 队列。

快照文件缺失或读失败时，按「没有快照」处理，会话是 `idle`。

### 4.4 无快照的暂停恢复

进程内出现过暂停、但没有走关闭流程（意外崩溃）时，`paused` 相位随进程消失，`snapshots` 表没有对应行。此时按能够推理出的最终状态恢复：从 `calls` 表中该会话未结束 turn 的 `status='pending'` 行判断——有则 `pausedAt='before-tools'`，无则 `pausedAt='before-model'`；`nextStep` 队列为空。推理不出任何未结束 turn 的会话就是 `idle`。

### 4.5 继续时补齐历史

继续时，`calls` 表中 `status='pending'` 的调用按原参数执行，结果写回 `call` 与 `messages`（`role=tool`），然后进入下一节点；`before-model` 的继续直接进入 `model-call`。历史由既有的上下文组装从存储重建，恢复路径不另写一套组装逻辑。

## 5 与既有机制的关系

- **审批**：暂停是批次级粗门，审批仍是调用级细门；两者不合并。继续后原有审批照常触发。
- **inbox**：暂停中收到的新消息默认进 `nextStep`（steer）；已经领取、正待消费的 `nextStep` 条目不属于待恢复队列，快照不记录它们。
- **goal**：暂停时立即 disarm，goal 本体的 phase 与轮数不变；继续不重新 arm，重新自动续轮只能走 `/goal resume`。
- **subagent**：暂停中的父 turn 不结算；子代理已经产生的消息留在 inbox 与存储，等父继续后再处理。
- **bare 模式**：没有实例与落库，不参与暂停。
- **session recovery**：本文件的快照只服务暂停；会话与在途任务的完整恢复是另一件事，两者共用「继续时按存储重建历史」的前提。

## 6 边界

本期做：

- 两个可暂停点（`before-tools` / `before-model`）；
- 暂停 / 继续 / 状态查询三个 RPC；
- 暂停卡片与 composer 按钮两态；
- 关闭应用时写暂停快照，启动时读快照恢复并清除索引行；
- 无快照时按 `calls` 的 pending 行推理暂停点。

本期不做：

- 停止 / 硬取消 / 丢弃本轮 / 重试本轮；
- 工具批次内部的暂停检查点；
- 单个工具的跳过或逐条确认；
- 暂停中自动开新 turn；
- 意外崩溃之外的其他恢复承诺（PTY、浏览器、MCP、后台作业的退出清理）。

## 7 测试

- 模型返回 2 个 tool call，暂停后两个都没执行；继续后各执行一次，且没有第二次模型请求。
- 模型请求进行中点暂停：请求不被打断，返回有 tool call 时停在 `before-tools`。
- 模型返回无 tool call：暂停请求作废，本轮正常结束。
- `pre-step` 之后暂停：停在 `before-model`，继续直接请求模型，`pre-step` 不重跑。
- 暂停中发新用户消息：进入 `nextStep`，不自动继续，不丢消息。
- 关闭应用写快照后重启：会话恢复为 `paused`、`pausedAt` 正确、未领取的 `nextStep` 条目还在；`snapshots` 行已被清除。
- 无快照的暂停会话：按 `calls` 的 pending 行推理出 `before-tools` / `before-model`。
- 暂停时 goal 被 disarm，继续后仍为 disarmed。
