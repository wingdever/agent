# OpenAI Agents SDK

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/openai/openai-agents-python （Python/JS，MIT）
- 文档：https://openai.github.io/openai-agents-python/

## 简介

OpenAI 官方轻量多 agent SDK：`Agent`（instructions + tools + handoffs + guardrails + structured output）+ `Runner`（管 turns/工具/guardrails/handoffs/sessions）。规模小，但 handoff/session/guardrail 的设计在官方 SDK 中最严谨。

## 关键特性

- **Handoffs**：交接目标对 LLM 是一个**工具**（`transfer_to_<agent>`），模型决定交接、harness 执行；`on_handoff` 回调（交接时刻触发副作用）；**`input_filter`** 过滤下一 agent 收到的历史（input_history/pre_handoff_items/new_items/input_items/run_context 五段可裁）；`is_enabled` 动态启停；`nest_handoff_history`（beta）：把交接历史压缩成有序摘要段，接收 agent 看摘要而非全量。
- **Guardrails**：input（与 agent 运行**并行**校验）/ output（生成后校验）/ tool（每次调用）—— trip 即**直接抛异常**（fail-fast，不让坏输入/坏输出通过）。
- **Sessions**：内置客户端 session 记忆（每次 run 前自动取历史、run 后自动存新 items）；多后端实现（SQLite/Redis/MongoDB/SQLAlchemy/Dapr/OpenAI Conversations）+ 包装型（compaction wrapper：按轮自动压缩；encryption wrapper）；`SessionSettings.limit` 控制取多少历史。
- **RunState**：中断状态序列化（HITL 审批 checkpoint），resume 时保持同一 session，历史不断裂。
- **Tracing**：内置全链路追踪。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M4 交接协议 | 最关键设计输入：**交接是工具调用（动作）而不是消息** —— 模型决定交接，harness 控制交接过去的历史（input_filter），回调挂副作用；`nest_handoff_history`（摘要后交接）解决接收 agent 上下文膨胀 |
| M1 ④ session-save | Session 一等对象（run 前取/run 后存，后端可换）—— 与 DSH session-persistence seam 同构；**RunState = "挂起状态接续"的具体形态**：待审批就是一个 RunState checkpoint，恢复 = 同 session 继续跑 |
| M4 交接校验 | guardrail fail-fast（trip 即异常而非警告）—— 我们接收侧校验的严格形态 |

## 链接

- https://github.com/openai/openai-agents-python
- https://openai.github.io/openai-agents-python/handoffs/
- https://openai.github.io/openai-agents-python/sessions/
