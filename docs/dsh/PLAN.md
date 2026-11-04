# DSH 借鉴 — 实现规划总览

> 本目录（`docs/dsh/`）是"从 DSH 学习优化 UI"的讨论与规划工作区。
> - `dsh-replica.md`：讨论结论与决策基线（已敲定，grill 产物）。
> - `PLAN.md`：本文件，各特性的实现规划草案与依赖关系。
> - `plan-*.md`：单项特性的详细实现规划。

## 0. 已敲定的决策约束（来自 dsh-replica.md）

实现任何一项前必须先满足这些约束，不允许 silent 偏离：

1. **学范式不追视觉**：交互/信息架构层面借鉴，不做视觉重设计。
2. **活动流转模型**（非锁定）：建会话选初始活动；活动完成后可自然流转（model 上报完成）；未完成强制切需 supervised 下内联 modal 二次确认，autonomous 下直接切。
3. **预设 = 仅活动模式（8 选 1）**，不含模型/权限。
4. **优先级**：#1 轨迹面板、#2 会话列表增强 先做；#3 @引用、#4 状态栏、#5 产物预览 二期；#6 推理档、#7 多模态 低优先。
5. **轨迹复用现有事件流**，不另起数据采集。

## 1. 特性清单与依赖

| # | 特性 | 阶段 | 关键依赖 | 规划文档 |
|---|---|---|---|---|
| 1 | 轨迹面板落地 | 一期 | store 已有 turns/steps/messages/calls；frontend 渲染 + show-trajectory CSS | [plan-trajectory.md](plan-trajectory.md) |
| 2 | 会话列表增强（CRUD+搜索+恢复） | ✅ 一期已完成 | store.sessions + 软删除/恢复；UI 搜索/回收站 | (已实现，见 dsh-replica.md §7.5) |
| 3 | 上下文 @ 引用 | ✅ 一期已完成 | composer `@` 菜单选会话/文件 → chip → `references` 传给 `chat()`；core `_resolveReferences` 注入上下文 | (已实现，见 dsh-replica.md §7.8) |
| 4 | 状态栏补齐（TPS/缓存/权限） | ✅ 已完成 | core `_stream` 解析 `usage` 上报 `usage` 事件；UI `chat-footer` 三 span 聚合活动/权限档/自主度、tokens/cached/TPS、steps/tools/耗时 | (已实现，见 dsh-replica.md §7.9) |
| 5 | 右栏产物预览 | 二期 | 现有 context-panel 改造 | (待写) |
| 6 | 推理等级控件 | 低 | core 模型层是否支持 reasoning effort（待确认） | (待写) |
| 7 | 多模态输入 | 低 | core provider 多模态支持 | (待写) |

## 2. 跨项前置任务（建议最先做，被 #1/#2/#3 共用）

- **A. 会话预设活动字段**：schema `sessions` 表加 `activity` 列（初始活动）；新建会话流程写入；core `chat()` 已接收 `activity` 参数，落库即可。这是 #2/#3 与活动指示器的数据基础。
- **B. 活动完成事件**：core 在活动完成时上报事件（plan 经 `exit_plan_mode` 批准、build-code 收尾等），供 UI 标记完成态。被活动指示器（grill Q14）需要，轨迹面板可顺带消费。
- **C. 活动指示器组件**：从 composer 移除 `activity-mode-selector`，改为会话内"当前活动指示器 + 可点击切换 + 完成态 + 强制切二次确认"。被 #1 的"按活动分组轨迹"自然复用。

## 3. 建议实施顺序

1. ✅ 前置 A（会话 activity 字段）—— 已完成：schema `sessions.activity` + store 落库 + 新建会话传参
2. ✅ 前置 C（活动指示器）—— 已完成：移除 composer selector，改为会话内指示器 + 切换菜单 + 强制切二次确认（supervised 弹窗 / autonomous 直切）+ 新建会话选初始活动
3. ✅ #1 轨迹面板（plan-trajectory.md）—— 已完成：core `session.trajectory` RPC + `getTrajectory` + 前端 `renderTrajectoryTree` 时间线
4. ✅ #2 会话列表增强（搜索 / 重命名 / 软删 / 回溯恢复）
5. 二期 #3–#5（待做）
6. 低优先 #6–#7（待做）

## 4. 数据模型现状（供规划参考，勿改 schema 除非必要）

`core/storage/schema.mjs` 已有层级：

```
sessions (id, workspace_id, name, description, created_at, updated_at)
  └ turns (id, session_id, seq, status)
      └ steps (id, turn_id, seq, status)
          └ messages (id, step_id, seq, role, content_id, thought_id)
          └ calls (id, reply_id→messages, seq, call_id, name, arguments, description, status, result_id, error, category)
goals (session_id, goal_id, revision, ...)
```

- 轨迹面板可直接 `listTurns(session_id) → listSteps(turn_id) → messages/calls` 聚合。
- **缺失**：`sessions.activity`（前置 A 要加）、活动完成事件（前置 B）。
- 存储引擎：pgmicro（PostgreSQL 兼容嵌入式），单文件 `./data/store.db`。注意 AGENTS.md 规则：改 schema 直接 rm db 文件重建，不做迁移。

## 5. 待澄清事实（实现前确认）

- core 是否在事件中上报 TPS / 缓存命中率（#4 状态栏前提）。
- core 模型层是否支持 reasoning effort 参数（#6 前提）。
- `show-trajectory` 的 CSS 显隐规则现状（#1 渲染前提，需读 styles.css）。
