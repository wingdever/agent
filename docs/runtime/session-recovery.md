# 会话恢复（session-save）

## 范围

本文件定义「关掉应用重开，会话和进行中的任务还活着」的实现方式：会话运行态如何落库、进程重启后如何恢复、哪些东西不恢复、恢复后用户看到什么。

它不定义长期记忆、跨会话检索、云端多副本或跨主机迁移。它也不把「恢复」等同于「自动继续执行」：恢复的第一目标是**不丢、可检查、可继续**，不是替用户重跑一遍。

相关文档：

- 轮次生命周期：[`../agents/lifecycle.md`](../agents/lifecycle.md)
- 实例状态归属：[`../agents/agent-instance.md`](../agents/agent-instance.md)
- 输入队列语义：[`../agents/inbox.md`](../agents/inbox.md)
- goal 的重启语义：[`../agents/goal.md`](../agents/goal.md)
- 存储真值：[`../foundation/storage/schema.md`](../foundation/storage/schema.md)
- 里程碑位置：[`../path/roadmap.md`](../path/roadmap.md) 的 M1

## 1 命名与原则

### 1.1 不是快照，是恢复投影

消息、turn、step、call、compaction 已经在 `store` 里；每个新 turn 都会从 surface 重建模型上下文。真正缺的是**运行态**：

- 这一轮跑到哪个节点、哪个 step；
- 还有哪些输入在排队；
- 哪些审批 / 提问 / plan review 在等人；
- 哪些工具调用已经开始、结果却不确定；
- 计划模式、goal 激活、后台作业、子代理处于什么状态。

因此不新增 `session.json`、不做定时快照、不做手动保存按钮。快照会和数据库分叉；正确做法是**持续写运行态事实，启动时投影成可运行状态**。

### 1.2 默认不自动重放

崩溃后自动继续执行，最大的风险是重复副作用：`bash`、写文件、`im.send`、workflow、browser 操作都可能已经执行过，但结果没落库。恢复必须遵守：

- 没有在途工具调用时，才允许从安全点继续；
- 有在途工具调用时，按 dispatch 标记分成 `not-started` / `unknown`，不自动重试；`unknown` 必须核实；
- 任何自动续跑都必须显式开启，并受预算 / 租约 / kill switch 约束。

### 1.3 恢复可重入

启动恢复只做状态收敛，不启动新 turn。重复执行恢复应得到同一结果：已经是 `interrupted` 的 turn 不再改；已经 `consumed` 的 inbox 行不再回队；已经 `orphaned` 的交互不再重复标记。

## 2 状态分层

| 层 | 内容 | 当前存放 | 恢复策略 |
|---|---|---|---|
| 会话事实 | 消息、turn / step / call、compaction、fork、委派关系 | `store` | 保留；补未完成状态 |
| 会话运行态 | `planMode`、`inbox` | Agent 内存 | 新增表持久化，实例创建时加载 |
| 轮次运行态 | 当前 turn、当前 step、下一节点、在途 call | turn / step / call 行 + 新增 `turn_runtime` | 标记中断；安全点续跑二期 |
| 待交互 | 审批、提问、plan review | `InteractionService` 内存 `Map` | 新增 `interactions` 表；重启标 orphaned |
| 真人任务 | user job | `user_jobs` 表 + 内存 resolver | 保持 pending，可继续完成 / 取消 |
| 目标 | goal phase / revision | goal 表 | 保留；activation 重启后 disarm |
| 后台作业 | job 状态 / 输出 | `jobs` + `job_owners` | running 标 interrupted，保留输出尾 |
| 子代理 | 子会话、消息、结算 | `subagents` 表 + 进程内 run | 子 turn 标 interrupted；向父会话投递通知 |
| 进程资源 | 终端 PTY、浏览器 context、LSP、MCP 连接 | 进程内 | 不恢复；下次用时重建 |
| 展示态 | todo 列表、选中会话、面板展开 | 实例 / UI | todo 只做历史展示，不作为权威状态 |

关键区分：**会话事实**已经是持久的；**会话运行态**才是这次要补的。

## 3 数据模型

项目没有迁移链，`ALTER TABLE` 对已有库不友好（pg-micro 会重写 CREATE 语句并丢掉方言标记）。因此新增能力一律走新表，用 `CREATE TABLE IF NOT EXISTS` 建；旧表的 `status` 是文本，可以直接写入 `interrupted` / `unknown` / `not-started`，不改列。

### 3.1 `session_runtime`

每个会话一行，存跨 turn 的会话级运行态。

| 列 | 含义 |
|---|---|
| `session_id` | 主键，引用 `sessions(id)` |
| `plan_mode` | 0/1，计划模式是否开启 |
| `plan_pending_exit` | 0/1，是否已请求退出计划模式、等下一步生效 |
| `updated_at` | 最后写入时间 |

`lastHeaderActive` 与 `notices` 不落库：前者由下一次 header 重算，后者是单轮转场提示。

### 3.2 `session_inbox`

一条待领取输入一行。它必须是**完整输入信封**，不能只存文本；当前 `agent.enqueue` 只保留 `content/source`，会把引用、模型覆盖、cwd 等丢掉。

| 列 | 含义 |
|---|---|
| `id` | 文本主键，UUID 或消息 id |
| `session_id` | 所属会话 |
| `queue` | `next-turn` / `next-step` |
| `source` | `user` / `goal` / `subagent-settle` / `job-settle` / `agent-message` 等 |
| `content` | 模型可见文本 |
| `meta` | JSON：`references`、`cwd`、`model`、`effort`、`toolNames`、`activity`、`contextMessages` |
| `status` | `queued` / `claimed` / `consumed` |
| `claimed_turn_id` | 被哪一轮领走；未领取为空 |
| `claimed_at` | 领取时间 |
| `created_at` | 入队时间 |

领取握手：

1. 入队先写 `queued`；
2. 轮首领取写 `claimed` + `claimed_turn_id`；
3. 首条 user 消息落库后写 `consumed`；
4. 启动时 `claimed` 但没有对应 turn / 首条 user 消息的，退回 `queued`；`consumed` 的清理掉。

`next-step` 在没有运行轮次时按 `next-turn` 处理；重启时不存在“半截 step”可接，回队比悬空安全。

### 3.3 `turn_runtime`

一轮一行，是这一轮的恢复游标与 owner 记录。会话级的跨进程单写者由 `session_lease` 负责，不靠这张表。

| 列 | 含义 |
|---|---|
| `turn_id` | 主键，引用 `turns(id)` |
| `session_id` | 所属会话 |
| `boot` | 启动标识；与 `AgentRuntime.bootId` 一致 |
| `owner_pid` | 写这一轮的进程 |
| `status` | `running` / `paused` / `interrupted` / `settled` |
| `next_node` | 下一个应执行的节点；安全点续跑用 |
| `last_step_seq` | 最后一个已完成的 step 序号 |
| `pending_calls` | JSON：当前 step 内未完成的 call `{callId,name,status}`；`status` 为 `not-started` / `started` / `unknown` |
| `meta` | JSON：`model`、`effort`、`activity`、`toolNames`、`header_hash` |
| `heartbeat_at` | 最后心跳 |
| `updated_at` | 最后写入时间 |

写入时机：

- `turn-start` 建行，`status=running`，`next_node=resolve-target`；
- 每个节点切换更新 `next_node`；
- 每个 step 边界更新 `last_step_seq` 与 `pending_calls`；
- `decide-next` 正常结束写 `settled`；
- 异常 / 取消写对应终态，并保留 `reason`（可放 `meta`）。

`pending_calls` 的 `status` 是恢复分类依据，不是展示字段：

- `not-started`：assistant 消息里已有 tool call，但 `calls` 行还没有 dispatch 标记；可以安全重试；
- `started`：工具 body 执行前已写 dispatch 标记；进程死在这里，结果未知；
- `unknown`：恢复时确认有 dispatch 标记、但没有结果；只能核实，不能假定成功或失败。

恢复后不保留 `started`：它必须被收敛成 `unknown` 或 `not-started`，否则 UI 会显示一个永远在执行的调用。

### 3.4 `interactions`

审批、提问、plan review 一行；user job 继续用 `user_jobs`，不复制成两份事实。

| 列 | 含义 |
|---|---|
| `id` | 文本主键，UUID；不能再用每 boot 从 1 开始的序号 |
| `session_id` | 所属会话 |
| `turn_id` | 所属轮次 |
| `step_id` | 所属 step |
| `call_id` | 触发它的工具调用 |
| `kind` | `approval` / `question` / `plan_review` |
| `payload` | JSON：工具名、参数、问题列表、计划正文、权限档位 |
| `status` | `pending` / `resolved` / `orphaned` / `cancelled` |
| `resolution` | JSON：approve/deny、answers、approved+feedback |
| `created_at` / `resolved_at` | 时间 |

`id` 必须跨 boot 稳定；当前 `_approvalSeq` / `_questionSeq` / `_planReviewSeq` 每进程从 1 开始，重启后会撞号，不能直接当主键。

### 3.5 `session_lease`

会话级写锁，保证同一会话同一时刻只有一个活写者。`turn_runtime.owner_pid` 只能证明“这一轮是谁的”，挡不住两个进程各开一轮、同时写同一会话。

| 列 | 含义 |
|---|---|
| `session_id` | 主键，引用 `sessions(id)` |
| `boot` | 当前持有者的 boot |
| `owner_pid` | 当前持有者进程 |
| `heartbeat_at` | 最后心跳 |
| `updated_at` | 最后写入时间 |

规则：

- 开新轮前先尝试获取 lease；同一事务内比较 `boot + owner_pid`，只有 owner 已死或 boot 已结束才允许接管；
- 活着的其他 owner 返回 `session-busy`，不排队、不抢占；
- 每个 step 边界更新心跳；正常 dispose 删除行；
- 恢复启动时只清扫 owner 已死的 lease，不清扫活行；
- lease 是跨进程约束，不替代 `activeSessions` 的进程内闸门；后者仍负责同进程并发。

单机 SQLite 可以用事务 + 唯一主键实现；如果后端不支持事务，退化为文件锁，不把 lease 逻辑塞进 `Agent` 内存。

## 4 轮次中断与 surface 修复

### 4.1 状态收敛

启动扫描 `turn_runtime` 中未终态的 turn：

- `boot` 是当前 boot → 不动；
- owner 进程已死或 boot 已结束 → `turn_runtime.status='interrupted'`；
- `status='paused'` 的 turn 不按 running 收敛，保留 paused，等待用户继续或取消；
- 对应 `turns.status='running'` → `interrupted`；`turns.status='paused'` 保留；
- 对应 `steps.status='running'` → `interrupted`；
- 对应 `calls` 分两类收敛：
  - 没有 dispatch 标记的 → `calls.status='not-started'`；
  - 有 dispatch 标记但没有结果的 → `calls.status='unknown'`；
  - 已有结果的按结果写 `succeeded` / `failed` / `denied`，不改。

`turns` / `steps` / `calls` 的 `status` 是文本列，不需要加约束。UI 不要把 `interrupted` / `unknown` / `not-started` 当普通失败渲染，要有单独文案：`not-started` 可以重试，`unknown` 必须核实。

### 4.2 surface 缺环修复

这是恢复里最容易漏、但会直接让下一轮报错的一步。

当前 `_projectMessages` 从 `calls` 表还原 assistant 的 `tool_calls`，tool 消息按同 step 内顺序配对。如果进程在「assistant 消息已落库、工具结果未落库」之间死掉，surface 会留下：

- 一条带 `tool_calls` 的 assistant 消息；
- 若干没有对应 tool response 的 call。

下一轮模型请求会因 tool response 缺失而失败。恢复必须补齐：

- 对每个没有 tool 消息的未完成 call，插入一条 `role=tool` 的合成结果；
- 按 `calls.status` 选择文案：
  - `not-started`：`interrupted before dispatch; tool was not started`；
  - `unknown`：`interrupted after dispatch; execution outcome unknown`；
- 如果该 call 可能已经产生副作用，文案必须说「可能已执行」，不能写成「未执行」；
- 合成消息按 call 顺序插入，保证 `_projectMessages` 的顺序配对正确。

如果 call 行有结果但 tool 消息缺失，按结果补 tool 消息；如果 tool 消息存在但 call 状态还是 pending，反向把 call 状态收敛为对应终态。

**写入侧的前置条件**：assistant 消息和它的 `calls` 行必须作为同一批提交。当前 `model-call` 先 `message.add`，再逐条 `call.add`；如果进程死在两者之间，`calls` 行完全不存在，恢复时无法从消息内容还原 `tool_calls`，这一段就是不可修复的缺口。需要给 store 增加 batch / transaction 原语，把 assistant 消息与 calls 放在一个提交里；否则 surface 修复只能覆盖“call 行已存在”的情况。

### 4.3 已完成部分不重写

已经 `succeeded` 的 step / call、已经写入的 assistant 内容、已经成功的 compaction 都不改。恢复只补状态和缺环，不做历史重写。

### 4.4 checkpoint 边界

只靠“执行完再写结果”会把崩溃窗口拉得很大。持久化必须在三个语义边界上有明确屏障，且失败时 fail-closed：

1. **模型请求前**：当前 surface 消息、`turn_runtime` 游标、`request/header` 等请求所需事实已持久化，再调用模型；
2. **工具 body 执行前**：`calls` 行与 `calls.status='started'` 已持久化，再执行可能产生副作用的 body；没有 `started` 标记的调用，恢复时归为 `not-started`；
3. **step 边界**：上一轮 assistant 消息和按序 tool 结果已持久化，再进入下一 step 的模型请求。

实现上需要一个 `store.flush()` / `store.barrier()` 语义：调用返回即代表此前写入已落盘；批量写可以后台合并，但 barrier 必须清空待写队列。barrier 失败时，模型请求或工具 body 不执行，turn 以错误结束，不带着“可能写了一半”的状态继续跑。

## 5 启动恢复

`createCore` 在 store 打开后、任何 agent 实例被创建前执行一次 `SessionRecovery.init()`。顺序固定：

1. 生成 / 读取当前 `boot`；
2. 扫描 `session_lease`：只删除 / 接管 owner 进程已死或 boot 已结束的行，活 lease 不动；
3. 扫描 `turn_runtime`，按 §4.1 收敛 turn / step / call；`not-started` 与 `unknown` 分开写；
4. 按 §4.2 修复 surface 缺环；
5. 扫描 `session_inbox`：
   - `queued` 保留；
   - `claimed` 但没有对应 turn / 首条 user 消息 → 回 `queued`；
   - `consumed` 清理；
   - 没有 turn 可接的 `next-step` → 改 `next-turn`；
6. 扫描 `interactions`：`pending` 且所属 turn 已中断 → `orphaned`；已经 resolved 的不动；
7. `jobs` 的 `running` 行由 `JobService.init()` 处理，改成 `interrupted` 并保留输出尾；不再用笼统的 `failed`；
8. `schedule` 由 `ScheduleService.init()` 重新装载；错过 occurrence 的补投策略仍按 `schedule.md`，不并入本文件；
9. 旧 boot 的 `compactions.status='running'` 标 stale / failed，避免压缩锁悬挂；
10. goal 不自动 rearm：`goal` 表保留 phase / revision，`armed` 仍是内存态；首次 `session:start` 照旧 disarm。

恢复过程不调用 `agent.chat`，不创建 turn，不触发模型请求。

## 6 恢复后的产品行为

### 6.1 打开会话

`session.runtime` 返回该会话的恢复视图：

```json
{
  "plan_mode": { "active": false, "pending_exit": false },
  "inbox": [{ "id": "...", "queue": "next-turn", "source": "user", "content": "..." }],
  "turns": [{ "id": 12, "seq": 7, "status": "interrupted", "last_step_seq": 3, "next_node": "pre-step" }],
  "calls": [{ "name": "bash", "status": "unknown" }],
  "interactions": [{ "id": "...", "kind": "approval", "status": "orphaned" }]
}
```

UI 根据它渲染：

- 顶部横幅：`上次执行在 Step 3 中断，未自动重试正在执行的工具`；
- 输入框旁显示排队消息数；
- 历史里该 turn 用中断样式，不显示成普通失败；
- `not-started` 的调用显示「未开始，可重试」；`unknown` 的调用显示「已开始，结果未知，需核实」；
- 审批 / 提问 / plan review 显示为「已中断，需要重新发起」；
- user job 显示为仍可完成 / 取消。

### 6.2 “继续”按钮

v1 的“继续”不是同 turn 自动续跑，而是发一条新的用户轮次：

- `source=resume`；
- 内容明确要求模型先检查当前工作区、最近工具结果和未完成项，再继续；
- 历史里的中断 turn 保留原样；
- 如果存在 `not-started` 工具，提示模型可以重试；
- 如果存在 `unknown` 工具，提示模型不要假设它成功或失败，先核实。

这样实现成本低，也不会重放任何工具。用户看到的是「恢复到可继续的状态」，而不是「假装什么都没发生」。

### 6.3 待交互

v1：

- 审批 / 提问 / plan review：`orphaned`，只读展示；用户点「重新发起」后由新的轮次重新走审批 / 提问；
- user job：仍为 `pending`，可完成 / 取消；完成后写 `user_jobs` 并投递一条 follow-up，不依赖旧 Promise。

v2 才做「在原工具调用处继续」：需要把 `interactions` 与 `turn_runtime.pending_calls` 对齐，在恢复时重新创建 pending resolver，并从 `tool-execute` 的安全点继续。v1 不承诺这个语义，避免出现“卡片能点、点了没反应”的假象。

## 7 续跑策略

### v1：恢复，不自动续跑

- 中断 turn 标 `interrupted`；
- 在途 call 按 dispatch 标记分成 `not-started` / `unknown`；
- 排队输入恢复；
- 审批 / 提问 / plan review 标 `orphaned`；
- 用户手动“继续”开新 turn；
- goal 保持 disarm；
- jobs / schedule 只做状态恢复，不自动重跑。

### v2：安全点续跑

- `turn_runtime.next_node` / `last_step_seq` / `pending_calls` 可用；
- 只有 `pending_calls` 为空时，才允许从 `next_node` 继续；
- 有在途 call 时，要求用户确认「重试 / 跳过 / 放弃」，不自动重放；
- 审批 / 提问在原 call 处重新发起，不另开新轮；
- 续跑仍受权限门、fs 策略、预算上限约束。

### v3：无人值守自动续跑

只对显式开启的 goal / unattended 任务生效，并且需要：

- 会话 lease + turn 心跳，避免两个进程同时续跑；
- 预算 / 轮次上限 / 熔断；
- 只从安全点续跑，不重放副作用工具；
- kill switch 与人工接管入口。

不满足这些条件时，自动续跑不开启。

## 8 接口与 UI

计划新增的 RPC：

| 名称 | 类型 | 用途 |
|---|---|---|
| `session.runtime` | read | 恢复视图：计划模式、inbox、中断 turn、待交互 |
| `session.continue` | write | v1 的“继续”：以 `source=resume` 开新 turn |
| `session.resumeTurn` | write | v2：从 `turn_runtime` 安全点续跑 |
| `session.inbox.remove` | write | 移除尚未领取的排队输入 |
| `interactions.pending` | read | 跨会话 / 移动端恢复待交互列表 |

UI 需要改三处：

- `ui/web/chat-tab.js` 的历史重建：识别 `turn.status='interrupted'`，渲染中断横幅与“继续”；
- `ui/web/sidebar.js` / 应用启动：打开会话时拉 `session.runtime`，恢复 inbox 计数与待交互；
- `ui/web/chat-tab.js` 的审批 / 提问 / plan review：除 live 事件外，也能从 `interactions.pending` 重建卡片，并区分 `pending` / `orphaned`。

## 9 与现有机制的关系

- **inbox**：内存队列的领取即消费语义保留，但入队前先写 `session_inbox`；领取 / 消费用手写状态机保证不丢。
- **session lease**：`activeSessions` 仍是进程内闸门；`session_lease` 补跨进程单写者约束。两者都通过才允许开轮，避免桌面端和 channel daemon 共用一个 store 时各跑一轮。
- **轮次生命周期**：`session:start` 仍在实例第一次开轮前发一次；恢复后的新实例照常触发，goal 照常 disarm。`turn:end` 不为恢复出来的中断 turn 补发；UI 用持久状态重建。
- **goal**：goal 表是事实，`armed` 是内存授权。重启不 rearm，是既有设计，不是 session-save 的缺陷。
- **turn-pause**：v1 的暂停只在进程内，不写 `turn_runtime`；v2 起 `paused` 是可继续安全点，恢复只恢复为 paused，不自动执行 pending calls。设计见 [`turn-pause.md`](turn-pause.md)。
- **jobs**：`job_owners` 的活进程判断继续用；状态从 `failed` 细化为 `interrupted`，保留输出尾。
- **schedule**：只重新装载，不把停机期间的所有 occurrence 逐条重放；仍按 `schedule.md` 的“只补最近一次”。
- **compaction**：`status='running'` 的旧 boot 行按 stale 处理；surface 只取 `succeeded`，不受影响。
- **subagent**：v1 只恢复根会话；子会话的中断 turn 标 `interrupted`，向父会话投递一条 `subagent-settle` 通知，不自动重启子代理。

## 10 边界

### 本期恢复

- 根会话的 plan mode、inbox、中断 turn、待交互、user job；
- jobs / schedule 的状态收敛；
- surface 缺环修复；
- 单 host、单写者：`session_lease` 挡住跨进程并发，`turn_runtime` 的 owner 检查避免误抢另一个活进程的 turn。

### 本期不恢复

- 终端 PTY、浏览器 context、LSP 进程、MCP 连接；
- 模型流式输出的半截 token；
- 进程内 job 的实际执行；
- 子代理的实际 run；
- 跨主机 / 多副本迁移；
- 自动重跑任何有副作用的工具。

### 明确不接受的做法

- 序列化 Agent 实例 / Promise / AbortController；
- 用 `session.json` 快照覆盖数据库；
- 启动时自动对所有 `running` turn 调 `chat`；
- 为了“看起来恢复”把 pending 审批保留成可点击、实际 resolve 不了。

## 11 测试

恢复的正确性靠崩溃注入，不靠单元测试里手写状态。

- **单元**：状态收敛、inbox 领取 / 回队、interaction orphan、surface 缺环修复、plan mode 加载、lease 获取 / 接管 / 拒绝；
- **进程级**：子进程在以下点 `kill -9`，重启后断言：
  1. `turn-start` 之后、模型请求之前；
  2. 模型流式输出中；
  3. assistant 消息与 calls 同批提交之前；
  4. assistant 消息已提交、call dispatch 标记之前；
  5. dispatch 标记已写、工具 body 执行中；
  6. 工具已产生副作用、结果未落库；
  7. 工具结果落库、下一 step 之前；
  8. 审批 / 提问等待中；
  9. inbox 已 claim、首条 user 消息未落库。
- **断言**：
  - 不丢排队输入；
  - assistant 消息与 calls 不出现“消息在、call 不在”的不可修复缺口；
  - 没有 dispatch 标记的调用标 `not-started`，有标记无结果的标 `unknown`；
  - 不重复执行副作用工具；
  - surface 不缺 tool response；
  - 中断 turn 可见；
  - goal 未自动续跑；
  - 另一个活进程的 lease 不被抢、turn 不被误杀。
- **兼容**：旧库中已有 `turns.status='running'` 但没有 `turn_runtime` 行，首次启动按 stale 处理；旧 `calls` 没有 `started` 标记的，按 `not-started` 处理。

## 12 待确认

以下三项是本设计的默认选择，落地前可以改：

1. **默认手动继续**：不在崩溃后自动开新 turn；goal / unattended 的自动续跑留给 v3。
2. **审批重启后 orphaned**：v1 重新发起；v2 再做原工具调用处继续。
3. **v1 只恢复根会话**：子代理只标中断并向父会话投递通知；子代理树整体恢复放二期。
