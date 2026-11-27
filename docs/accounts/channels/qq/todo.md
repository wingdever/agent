# QQ channel 微服务待办

按"先跑通闭环 → 补齐设计已定项 → 再健壮"的顺序列出剩余工作。每项说明目标与当前状态。

## 闭环缺口

### 状态迁移（范围已收窄）

原先列出七类状态全迁入消息库，按当前架构复核后范围收窄：

- `dedupe`、`sessions` 在 `channels/inbound/`，是所有 channel 驱动共用的**共享层状态**，不属于 QQ 微服务特有。`dedupe` 已用 JSON 文件跨重启；`sessions` 只在 launcher 的本地 sink 路径使用，core-pull 下开 transient agent、不传 sessionId，根本不经过它。
- `pendingActors`、`questionBatches`、`textWaits` 由 `project()` 的审批/提问/计划分支写入，但 `channel-send` 节点只发 `final` 文本，不产生交互事件。按钮交互暂不实现时这三类表没有写入者，无需迁移。
- `replySeq` 仍活跃：`/proactive` 经 `project()` 的 `final` 分支递增 `msg_seq`。重启后序号从 1 重置，**已实测**（`test/channels/qq/replyseq-restart.test.js`）：
  - 一轮内多条出站（卡片 seq=1 + final seq=2）在重启点拆开时会撞成两个 `m:1`；
  - 但 core-pull 下 `channel-send` 每轮只发一条 final（`seq=1`），且 `final` 发完即 `replySeq.delete(key)`，正常情况下不会到 seq>1，重启重置无害。
  - 残留风险仅在"restart 恰好发生在卡片已发、final 未发"的窗口——而按钮交互暂不实现，这个窗口不存在。

`replySeq` 无需迁移到消息库。

`dedupe` 的迁移已评估并实施（`dedupe-evaluation.md`）：性能不是问题（实测 2000 条全量写单次 0.18ms），真实缺陷是 JSON 中途崩溃会截断导致 24h 重投重复。已实施方案 A——`persist()` 改临时文件 + rename 原子写，不动共享层同步契约，测试验证无残留 `.tmp`。状态迁移项至此收口。

### 冷数据归档

已实现：热库保留 90 天，`history.archive()` 按月导出独立 SQLite 文件（`YYYY-MM.db`）到 `data/archive/qq/` 并删除热表行（只归档已投递消息）；reader 读热库 + 全部归档库。channel-run 启动时归档一次。

### 真实账号部署验证

真实账号已实测：WS 连接/IDENTIFY/READY 全通过（官方 WS 链路仍可用）。但首轮验证暴露三个 bug 并已修复：
- `channel-listen` 入口节点跳过 `assemble-input`，`request.messages` 为 null → model-call 崩溃；入口阶段现在自建 system+user 前缀。
- turn 失败时仍无条件 ACK → 消息被错误标记 delivered；现在仅成功时 ACK。
- 跨进程 DuckDB 只读打开被写锁拒绝 → 消息库从 DuckDB 换成 SQLite WAL（实测跨进程单写多读成立），reader 直接只读打开同一文件，砍掉 HTTP history 端点。

后续真实验证又暴露并修复了三个 bug：入口节点 `next` 直跳 model-call 导致 `baseUrl`/`translateCfg` 未初始化（改为走完整管道 + 入口阶段初始化）；`_context()` 没透传 `channelMessage`；channel-run 的 callback 漏配 `onAck`。

最终真实验证通过：QQ 私聊消息触发 turn 成功、模型调用 200、回复发到 QQ；数据库显示入站消息 delivered=true、attempts=2，出站消息已写库。重连重放路径也验证了——首次未 ACK 的消息在 channel 服务重启后被重放、二次处理后 ACK 成功。

**重复回复已修复**：core 侧 `channel-listen` 在消费入口用 `createDedupe()` 对 eventId 幂等——重复事件不跑第二次 turn，但仍 ACK（否则 channel 服务会无限重放）。去重状态持久化到 `data/channels/core-dedupe-<id>.json`，跨重启保留。`POST /proactive` 新增 `status: "ack"` 纯确认语义。测试验证重复事件只触发一次 turn 且被 ACK。

## 数据语义与健壮性

### 投递确认语义

已实现 ACK，合并进 `POST /proactive`：channel 服务发布时只 `markPublished`（attempts+1）；`channel-send` 发回复带 `ackEventId`，服务发送成功后一并 ACK；turn 失败发 `status: "failed"` 只 ACK 不发送。重连时 `getPending` 返回未 ACK 且 attempts<5 的消息，超过自动丢弃。测试覆盖 publish/ACK/attempts 上限与真实 HTTP。

### 交互回调

按钮点击的回灌暂未实现。审批卡、提问卡在 core-pull 模型下要么失效，要么只能自动拒绝。需要在 channel 服务侧增加交互事件订阅流，与消息流对称。
