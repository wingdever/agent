# Letta（MemGPT 系）

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/letta-ai/letta
- 博客：https://letta.com/blog

## 简介

memory-first 的模型无关 agent harness（Letta Code）；主张「你拥有记忆，你选模型，可见到每个 LLM 输入输出 token」。跨会话记忆设计在所有参照中最激进也最完整。

## 关键特性

- **Context Repositories（MemFS）**：记忆 = git 支撑的文件系统，agent 用普通终端/编码能力（写脚本、spawn subagents）管理记忆；每次记忆变更自动版本化（有信息量的 commit message）。
- **Sleep-time compute**：compaction 后的反思步骤，把近期对话沉淀进记忆（后台、不占交互）。
- 记忆技能三件套：初始化（并发 subagent 用 git worktree 探索代码库/历史会话建记忆结构）、反思（sleep-time 定期沉淀）、**碎片整理**（subagent 重构记忆文件为 15–25 个聚焦文件）。
- **多 subagent 并发写记忆**：各 subagent 隔离 git worktree，处理完经 git 冲突解决合并回共享记忆库。
- **Trajectory**（2026-07）：开源包，把 Claude Code / Codex / Letta Code 等 harness 的会话数据归一化成 token 高效的 agent 经验格式 —— 跨 harness 学习的基础设施。
- 研究方向：memory models（为"创建与策展 token 空间记忆"专门训练的模型）、多模型 agent（记忆跨模型代际迁移）、harness 自修改（harness 本身作为可学习的记忆载体）。

roadmap 要点（Next Phase 2026-03，含明确弃用清单）：
- 记忆从"专门记忆工具改数据库"→"computer use 操作 git 支撑的上下文仓库"；**"记忆不是插件，是 harness 的核心职责"**（Why Memory Isn't a Plugin：AGENTS.md 怎么进上下文、压缩后什么存活、交互是否可查询 —— 这些决策外部插件控制不了）。
- 弃用方向：server 端记忆工具 → 文件系统操作；server 端 MCP 集成 → client 端 skills；server 端 sleep agent → client 端 subagent；**server 端多 agent 工具 → subagents + 动态 agent 发现技能**；硬编码 tool rules 弃用（抑制前沿能力）。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M2 ⑦ memory | **memory gap 的最强论证**：所有头部 harness（Letta/OpenClaw/OpenHands/Goose/Hermes/Claude Code）都把跨会话记忆当核心能力而非插件 |
| M4 多 agent | **git-backed 记忆 + subagent 并发写**：多 agent 共享状态的候选路径（git 做冲突解决，天然契合开发场景） |
| M3 ⑯ plugin-system | 弃用清单的警示：核心里硬编码规则/工具最终都会被 skills/subagents 取代 —— 设计时避免把能力焊死在 core |
| 自我进化（新候选项） | sleep-time compute（空闲时离线整理记忆）是"自我进化"的温和形态 |
| 现状对齐 | 我们的 `harness-trace/` + `session-reference` 工具已在 trajectory 方向上（会话归一化 → 可被后续会话/子 agent 引用） |

## 链接

- https://letta.com/blog/our-next-phase
- https://letta.com/blog/context-repositories
- https://letta.com/blog/why-memory-isnt-a-plugin
- https://letta.one/research
