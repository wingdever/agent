# 事件溯源（Event Sourcing）与 DSH 的设计

> 背景概念文档。解释什么是 event sourcing、DSH 的会话层为什么是事件溯源的，
> 以及本项目采用了哪一层（消息与压缩都是关系表，未事件化）。
> 压缩的具体实现见 [context-compact.md](context-compact.md)。

## 1. 一句话

**事件溯源 = 不存「当前状态」，只存「发生过什么」；当前状态由事件按顺序回放（fold）得到。**

银行账户不存余额，存流水，余额是流水求和；会话不存「消息表作为真值」，存事件日志，
模型看到的历史是日志的一个投影。

## 2. 和状态存储（CRUD）的对比

| | 状态存储（CRUD） | 事件溯源 |
|---|---|---|
| 存什么 | 当前状态（UPDATE 覆盖） | 每次变化一条不可变事件（append-only） |
| 历史 | 覆盖后丢失 | 天然完整 |
| 当前状态 | 直接读表 | 回放事件，或读投影 |
| 审计 / 回放 | 难 | 一等公民 |
| 修改历史 | UPDATE / DELETE | 追加一条「修正」事件 |
| 典型代价 | 查询简单 | 日志膨胀、replay 成本、事件版本管理、隐私删除 |

## 3. 核心术语

- **event store**：append-only、带单调 `seq` 的日志；
- **fold / replay**：从空状态依次应用事件，得到任意时刻的状态；
- **projection（读模型）**：从同一份日志派生出的视图（模型可见历史、transcript、token 统计等）；
- **snapshot**：日志过长时定期保存折叠结果，避免每次从头 replay；
- **replace / shadow**：日志不改，但投影可以让某个事件「遮蔽」旧事件（压缩就是这种）；
- **upcasting**：事件 schema 演进时把旧事件升级成新格式。

## 4. DSH 是不是事件溯源？

**会话层是，而且文档写得很直接。**

> "The in-memory, **event-sourced** model … A `Session` is an **append-only log** of typed
> `SessionEvent`s — the **single source of truth** … The LLM message history is *derived*
> from the log, never stored separately; replay is re-derivation from the same events."
> — [docs/subsystems/session.md](../reference/deepseek-harness/docs/subsystems/session.md)

> "The package is built on **event sourcing** … everything else — model history, transcripts,
> telemetry, titles, persistence — derives from that stream. … **Model-visible means logged**:
> anything that reaches a model request must be reconstructable from the log."
> — [packages/core/session/README.md](../reference/deepseek-harness/packages/core/session/README.md)

具体到实现，这些东西都是同一份日志的投影：

| 投影 | 说明 |
|---|---|
| **surface** | 模型可见历史；`surfaceOp: replace` 遮蔽旧 span，由 `SessionSurface` 增量维护 |
| **transcript** | 人类阅读的历史；读 append-origin 事件，所以压缩后仍显示原文 |
| **token meter** | fold 同一串事件，得到 per-node 价格、context pressure、usage 锚点 |
| **request/header** | 某次请求的 system/tools/模型也记录成事件，「每个请求都是日志的纯函数」 |
| **compaction** | `compaction/start` / `summary` / `end` 是 log-only；真正改 surface 的是带 `surfaceOp: replace` 的 `user/message` |
| **persistence** | 独立 seam；后端订阅 `session/event` 落盘，崩溃恢复/回放都基于日志 |

goal 域同样是事件溯源的（`docs/subsystems/goal.md` 称为 "event-sourced goal service"）。

### 4.1 「一切皆事件」是 DSH 的口号吗？

**不是。** DSH 全仓的架构口号是 **「一切皆插件」**（everything is a plugin）：
微内核 + 少量抽象服务 + 插件组合
（[docs/i18n/style-samples.md](../reference/deepseek-harness/docs/i18n/style-samples.md)）。
插件、服务、配置、UI 组件并不是事件。

更准确的说法：

> DSH 的**会话（和 goal）域**是彻底的事件溯源；硬规则是「模型可见的必须可记录、可重放」
> （model-visible means logged）。「一切皆事件」是对它的过度概括。

## 5. 为什么事件溯源适合 agent 会话

- **可回放**：同一份日志能重建任意时刻的 surface/请求，调试「模型当时到底看到了什么」；
- **多投影**：模型视角（surface）、人类视角（transcript）、计费/压力（token meter）各取所需；
- **压缩安全**：压缩只改 surface，日志保留原文；transcript/审计/回放都不丢；
- **锁与崩溃语义**：压缩的 start/end 本身就是日志事件，崩溃后能判断 orphan；
- **可重建性**：`request/header` 记录 system/tools，使「请求是日志的纯函数」。

## 6. 本项目的中间态

压缩子系统用关系表实现，但**没有**把整个会话重写成事件：

| 层 | 本项目 | 说明 |
|---|---|---|
| messages | 关系表 + `surface_seq` | append-only；压缩不改写原行 |
| 压缩 | `compactions` 关系表（start_seq / end_seq / status / boot） | 与消息 seq 共用 per-session 序列 |
| surface | `getSurface()` 回放 messages + 按 `compactions` 做区间替换 | 只在读模型里遮蔽旧消息 |
| transcript | UI 读 messages（append-origin） | 压缩后仍显示全部原文 |
| token meter | 独立模块 + `token_anchors` 表 | 锚定 provider usage |
| turn/step/call | 关系表，未事件化 | 轨迹/回放仍读关系表 |

这个中间态覆盖了压缩所需的全部 DSH 语义（锁、区间遮蔽、失败留痕、多次压缩叠加），
代价是不具备「任意时刻全量 replay 所有 turn/step」的能力。

**完整 event sourcing 的收益与代价**：

- 收益：任意时刻精确回放、统一投影、审计能力最大化；
- 代价：持久层、UI 渲染、查询、测试整体重写；事件 schema 演进与存储膨胀问题；
- 结论：对「复刻 `/compact`」不是前置条件；是否做取决于是否真的需要「回放任意会话的
  模型输入」这类能力。

## 7. 容易混的几个概念

- **Event sourcing**：日志是状态的真值来源（DSH 的 session）；
- **Event-driven**：组件之间通过事件通知解耦（DSH 的 `session/event` 订阅、cancellation）；
- **Event log / audit log**：只追加记录，但不一定用来重建状态；
- **CQRS**：读写模型分离；常与 event sourcing 一起用，但不是同义词。

DSH 同时用了 event sourcing（会话真值）和 event-driven（插件/客户端订阅），
但两者是不同层次的设计。
