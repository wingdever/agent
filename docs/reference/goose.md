# Goose (Block)

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/aaif-goose/goose
- 文档：https://goose.gitbook.io / 仓库 documentation/

## 简介

Block 出品的 local-first 可扩展 agent 平台，MCP-native（第一个支持 MCP 的开源 agent）。扩展规范与协议方向（开放插件 spec、ACP+）是我们 plugin-system 落盘前最重要的外部设计输入。

## 关键特性

- 扩展体系 = MCP（stdio / builtin / streamable_http / platform / inline_python 五种传输/类型），扩展目录 + 恶意包扫描 + allowlist。
- **Platform extensions**（内置全局能力，可开关）：Memory（记偏好）、Chat Recall（**跨全部历史会话搜索**）、Todo（**跨会话**任务列表）、Top of Mind（每轮注入持久指令）、Summon（加载知识源 + **委托 subagent**）、Analyze（代码结构/符号调用图）、Apps（HTML app 管理）、Extension Manager、Code Mode。
- 交互：subagents（独立实例，主会话保持干净）、message queue、message editing、**interrupt tasks**（运行中打断夺回控制权）、session import/export、**fork conversation**（改历史消息派生新会话）、lead/worker model、**scheduled recipes**、`@goose` 终端原生调用。
- Skills：可加载 Claude 格式技能（项目/全局位置）。
- 协议：ACP 已支持。

roadmap 要点（2026-02→05 官方 discussion）：
- Open Models：内置推理与开源模型下载（无外部 runtime），为小模型调优 loop（紧 schema、少轮次、可降级）。
- Apps：MCP-UI → MCP-Apps → 独立 app → **app 反向扩展 goose 自身**（app 变一等扩展）。
- **Meta-Agent Orchestration**：recipes 一等化可组合（subrecipes + 并行 subagents）、任务/进度跟踪、明确的执行模型（隔离、可选本地容器）、project types 与 workflows。
- **Protocol**：选定 **ACP+**（建于 ACP 之上）作为 client↔harness 协议；小且稳定的协议面；client-server 架构（即使本地）。
- **Open Plugin Support**：开放插件规范 `.plugin/plugin.json` 清单，一个插件目录 = skills + MCP servers + commands + agents + rules + hooks 的任意组合；组件命名空间 `{plugin}:{name}`；**目标：按规范写的插件放进任何兼容 host 都能跑**（跨 host 可移植）。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M1 ⑤ goal-auto-continue | **Ralph Wiggum Loop**：循环执行直到任务"真正完成" —— 续轮判据是完成度而非固定轮数（与我们 max_goal_rounds 上限互补） |
| M3 ⑯ plugin-system | **开放插件规范**：落盘前需做设计决策 —— 遵循开放规范（可移植、生态复用）还是自有格式（简单、自控）；`.plugin` 目录格式是最完整的参照 |
| M2 ⑦ memory | Chat Recall / Top of Mind / 跨会话 Todo：比完整记忆系统轻得多的「准记忆」形态，低成本补 gap |
| M3 ⑬ mcp | 扩展 = MCP 的五种传输/类型 + 恶意包扫描 + allowlist（安全细节） |
| 增强包 interaction-ux | interrupt + queue + fork：日常交互三件套的另一个参照 |
| M4 多 agent | ACP/ACP+ 作为 client 协议参照；meta-agent orchestration 的"执行模型 + 进度跟踪"是 M4 的架构输入 |

## 链接

- https://github.com/aaif-goose/goose （discussions #6973 / #9173 / #6474 / #6852）
- documentation/using-extensions.md （platform extensions 全表）
