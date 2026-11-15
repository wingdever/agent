# OpenClaw

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/openclaw/openclaw
- 社区路线图摘要：https://clawbot.ai/wiki/community/openclaw-roadmap.html

## 简介

开源个人 AI 助手（多渠道：Discord/Telegram/WhatsApp/iMessage + 原生 app），local-first —— 状态/记忆/凭据留在自己的硬件上，模型与 agent harness 是可替换插件。**与本项目「日常个人 agent」定位最接近。**

## 关键特性

- 原生工具 34 → 48，含 `cron`、`memory_get`、`sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`、`agents_list`、`apply_patch`、`profile_write`（见 openclaw.net 移植版 ROADMAP，反映上游工具集）。
- 工具预设与分组（full / coding / messaging / minimal + 7 个内置 group）。
- chat 命令：`/think`（推理档）、`/compact`（压缩）、`/verbose`。
- 长任务 **checkpoint + resume**：每个完成的 tool batch 后打持久保存点，中断后从最近完成 batch 恢复。
- 多 agent 路由：按 channel/sender 路由，model override、route-scoped prompt、工具 allowlist。
- 插件安装器（npm / ClawHub）；ClawHub 技能市场。
- 社区路线图要点：plugin-driven 架构转向、多 agent 协作 Team RFC（共享任务列表、依赖管理、agent 间异步通信）、可插拔 memory 模块、安全加固。

roadmap 要点（官方 VISION.md "Our priorities, in order"）：
1. 质量与开发者体验：安全与 safe defaults、bug fix/稳定性、首跑体验、性能/可靠测试/清晰的插件 API。
2. Runtime：**可靠的 sessions / automations / subagents**、更简单的 memory 与 knowledge、覆盖主流 model provider、可靠的消息渠道、更好的 computer use 与 agent harness。
3. 运维与应用：可靠自托管、CI/release 效率、跨平台一致（macOS/iOS/Android/Windows/Linux）。

另有一节 **"What We Will Not Merge (For Now)"**（roadmap guardrail 清单）：core 不收可放 ClawHub 的技能、vendor 集成进 core 的拒绝（走插件）、重复 MCP/ACPX 路径的工作不做、重型编排层不做。——「显式不做清单」这一形式值得借鉴。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M1 ④ session-save | checkpoint 粒度 = 完成的 tool batch（不是每条消息），恢复点明确 |
| M4 多 agent | team RFC 的共享任务列表 + 依赖管理 + 异步通信，是我们「协作与交接协议」的现成参照 |
| M3 ⑮ schedule | cron 工具 + 多渠道投递是日常 agent 标配（印证该条目） |
| M0–M4 整体 | 「won't-merge」guardrail 清单形式 —— 我们 roadmap 的 principles 节可扩充为显式不做清单 |

## 链接

- https://github.com/openclaw/openclaw （README / VISION.md）
- https://clawbot.ai/wiki/community/openclaw-roadmap.html （社区摘要）
