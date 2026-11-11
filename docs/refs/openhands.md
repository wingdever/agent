# OpenHands

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/OpenHands （主仓）
- https://github.com/OpenHands/software-agent-sdk （SDK）
- v1 博客：https://openhands.dev/blog/the-path-to-openhands-v1

## 简介

开源软件开发 agent → v1 大重构（SDK + CLI + Server）；Agent Canvas = 自托管多 agent 控制中心，可跑 OpenHands / Claude Code / Codex / Gemini / 任意 ACP 兼容 agent。

## 关键特性

- Agent SDK：`LLM` + `Tool` + `CodeActAgent` + `Conversation` 的轻量库，**同步** conversation API；CLI 默认直接跑在工作站上（不再默认 Docker）。
- Agent Server（REST，单机多 agent）+ **Automation Server**（定时 / webhook 触发的 agent 运行）。
- Agent Canvas：跨 local/Docker/VM/cloud 后端切换，自动化接 Slack/GitHub/Linear。

roadmap 要点（v1 博客 + feature-parity tracker）：
- v1 重构动机：18 个月有机生长后代码库失控，且初版事件模型（EventStream pub/sub）被判定"难以使用、线程/异步问题多、消息顺序无保证"—— v1 改为同步 conversation。
- Claude Code 能力对齐全景（tracker，8 个领域）：**Skills**（subagent 执行）、**Delegation**（后台执行、model routing、**file-based agents**）、**MCP**、**Memory**（跨会话持久自动学习）、**Session**（checkpoint、选择性 undo、CLI 管理——已完成）、**Hooks**（事件系统）、**Task Tracker**（依赖/ID/操作）、**Self-Knowledge**（agent 自文档化 + 技能创作辅助）。
- 后续：Cloud GA、集成（Jira/Linear）、按组织/个人定制。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M1 ④ session-save | Session checkpoint + 选择性 undo：checkpoint 不只为了恢复，也支持回退实验 |
| M4 专门 agent | **file-based agents**：用文件定义 agent（prompt + 工具集 + 模型）—— 我们 M4 的轻量落地形式 |
| M0 ② 拆分 | EventStream 翻车教训：事件模型宁可简单，复杂 pub/sub 的维护成本会反噬 |
| M2 ⑦ memory | Memory 被列为一级能力（跨会话持久自动学习），印证 memory 条目 |

## 链接

- https://openhands.dev/blog/the-path-to-openhands-v1
- https://github.com/OpenHands/software-agent-sdk （feature-parity tracker）
- https://github.com/OpenHands （Agent Canvas README）
