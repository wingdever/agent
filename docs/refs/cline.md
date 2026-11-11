# Cline

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/cline/cline （含 `sdk/`）
- SDK 博客：https://cline.ghost.io/introducing-cline-sdk

## 简介

编码 agent SDK + IDE 扩展（VS Code/JetBrains）+ CLI + 桌面端；2.0 起全部重建在开源的 `@cline/sdk` 上。"会话独立于 UI 生命周期"这一表述是 session-save 条目最直接的官方参照。

## 关键特性

- 分层 SDK，依赖方向严格单向：`@cline/shared`（契约/hook 引擎/扩展注册表）→ `@cline/llms`（provider 配置/模型目录）→ `@cline/agents`（**无状态** agent loop、工具编排、事件流）→ `@cline/core`（**有状态**编排、session 生命周期、存储、配置监听、插件加载、hub daemon）→ 各 app。
- 官方对重构的表述：「long-running work no longer dies with a UI restart; **Sessions can move across surfaces**」—— 长任务不再因 UI 重启而死，会话可跨界面迁移；底层 loop 保持无状态可复用。
- 插件系统：Plugins = 自定义工具 + 工作流 + 技能 + MCP 能力的打包；Customize marketplace（安装/卸载/启用/禁用、搜索过滤、插件可捆绑技能）。
- 交互体验：**queued prompts**（agent 工作时排队发消息）、edit-and-regenerate（改历史消息重跑）、checkpoints（agent 改动的可回退检查点）、mistake limits（错误次数限制）。
- Plan/Act 模式 + 自动从 Plan 切 Act 的继续执行；compaction 与 mistake-limit 走 SDK 统一。
- **subagents 已实现但 VS Code 端暂时禁用**（"Temporarily disable subagents... while the SDK-backed experience is stabilized"）—— subagent 体验不稳时先下架的实例。
- Kanban：CLI 无关的多 agent 编排 app，主张「2026 年的瓶颈是人的注意力，不是 agent」。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M1 ④ session-save | 目标形态直接对应：session 是一等对象，独立于 UI 生命周期、可跨 surface 迁移、长任务可存活 |
| M0 ② 拆 AgentCore | 无状态 loop / 有状态 runtime 分层：loop 保持无状态，会话/持久化/配置进独立有状态层 |
| M3 ⑯ plugin-system | plugin = tools + workflows + skills + MCP 的打包单元（与 Goose 目录 manifest、Claude Code 插件对照） |
| 增强包 interaction-ux | 交互三件套（排队 / 中断 / 编辑重发）是日常 agent 的高频体验项 |
| M3 ⑪ subagents | subagents 未稳先禁用的克制：我们 M3 ⑩ 可先做后收口，稳定前不在 UI 主推 |

## 链接

- https://github.com/cline/cline （README / releases v4.0.0 / sdk/AGENTS.md）
- https://cline.ghost.io/introducing-cline-sdk
