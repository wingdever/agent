# Codex CLI (OpenAI)

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/openai/codex （Rust，Apache-2.0）
- 文档：https://learn.chatgpt.com/docs/codex-manual

## 简介

OpenAI 的开源终端编码 agent + Codex Cloud（远程执行）。"多 agent 并行 + 云端交接"的参照，并行会话管理形态在开源项目中最完整。

## 关键特性

- **AGENTS.md 层级**：`~/.codex` global → repo → 子目录（更近的优先）；`/init` 脚手架生成；官方维护建议："Codex 同一个错误犯两次，就让它写 retrospective 并更新 AGENTS.md" —— 把重复失败沉淀进指令文件。
- **Subagents**：当前版本默认开启；并行 agent + `/subagents` 检视/切换线程；自定义 agent（TOML：不同模型/指令）；`agents.max_concurrent_threads_per_session` 上限；官方指导：**读重**（探索/测试/triage/摘要）适合并行，**写重**易文件冲突需谨慎。
- **codex cloud**：云端任务（每任务独立 workspace，笔记本合盖继续跑，跨设备交接，**named sessions** 管理连续性）；`codex cloud exec --env <id> "任务"` + `codex apply <task_id>` 把 diff 拉回本地。
- **`/agents` view**（DevDay 2026）：单个 TUI 面板管理多个并行会话 —— 状态着色（running/waiting/complete/error）、按 agent 中断、attach 看历史、新建会话。
- **`/fork`**（v0.157）：从当前会话上下文派生新并行会话；**instant_interrupt**（v0.159）：立即暂停，不等当前工具调用完成。
- **其它**：`codex resume`（回到已存 chat，可跨 chat 搜索）、`--image`（视觉上下文）、live web search、`codex exec`（脚本/CI 非交互）、`codex mcp`、`/permissions`、`/review`、`/model`（模型 + reasoning effort）。
- **worktree 协议**：官方并行 agent 惯例是每任务一个 git worktree（独立 checkout + 分支，review 后合并），避免多 agent 写冲突。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M3 ⑪ subagents | 读重/写重并行指导 + 线程检视 UI —— 我们 subagent 调度规则与轨迹展示的直接设计输入 |
| M4 多 agent | `/agents` 面板 = 最实用的"多 agent 控制中心"形态（我们可先做本地版：会话列表 + 状态 + 中断 + attach）；codex cloud 的 named sessions + 跨设备交接 = 长期形态 |
| M4 交接协议 | worktree 模式（每并行 agent 独立 checkout，review 后合并）—— 现成的文件级冲突避免协议 |
| session-fork | `/fork`（从会话上下文派生并行会话） |
| 增强包 interaction-ux | instant_interrupt（不等当前工具调用完成即中断）—— "运行中中断"的强化形态 |
| M2 ⑦ memory | "重复犯错 → retrospective → 更新指令文件"的触发模式 —— 低成本记忆沉淀规则，可写进 memory 条目的策展规则 |

## 链接

- https://github.com/openai/codex
- https://learn.chatgpt.com/docs/codex-manual （Subagents / AGENTS.md）
- https://learn.chatgpt.com/docs/codex/cli
