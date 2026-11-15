# Claude Code (Anthropic)

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- 闭源（商业产品）；官方文档：https://code.claude.com/docs
- 作为 harness 扩展设计的业界事实标准，功能清单以官方文档为准。

## 简介

Anthropic 的终端编码 agent。扩展面（CLAUDE.md / skills / subagents / hooks / plugins / dynamic workflows / cross-session messaging）是主流 harness 中最全的，也是其它开源项目（OpenHands feature-parity tracker）逐项对标追赶的对象。

## 关键特性

- **记忆双轨**：
  - CLAUDE.md 四层：org 策略 → user（`~/.claude/CLAUDE.md`）→ project（`./CLAUDE.md` 或 `AGENTS.md`）→ local（`CLAUDE.local.md`，gitignore）；目录树从根到工作目录拼接加载；子目录 CLAUDE.md **懒加载**（读到该目录文件时才载入）；`.claude/rules/` 按文件类型限定规则。
  - **auto memory**：Claude 自己写的笔记，四类：`user`（偏好）/ `feedback`（纠正）/ `project`（进行中的工作）/ `reference`（外部指针）；per repository，每会话加载前 200 行 / 25KB；策展规则：能从代码推导的不存，CLAUDE.md 已说的不存。
- **Skills**：`SKILL.md` 懒加载（列表只有元数据，body 调用时才载入）；`/skill-name` 显式调用或模型自动触发；`context: fork` 在隔离子 agent 上下文执行；插件可捆绑 skills（命名空间 `/plugin:name`）。
- **Subagents**：独立上下文窗口 + 独立 system prompt/工具/权限；可路由便宜模型；`skills` 字段启动时预载技能内容；`memory` 字段提供持久记忆目录（user/project/local 三 scope，`agent-memory/<name>/`）；hooks 在子 agent 生命周期内同样触发（SubagentStart/Stop）。
- **Hooks**：生命周期事件（PreToolUse/PostToolUse/Stop/SubagentStart/…）→ 跑脚本 / HTTP 请求 / MCP 工具调用 / prompt / subagent；可拦截或修改工具调用。
- **Plugins + marketplace**：`.claude-plugin/plugin.json` manifest，捆绑 skills/agents/hooks/MCP servers；marketplace 一键安装、命名空间共存。
- **Dynamic workflows**：Claude 写编排脚本（`workflows/*.js`）跑大量 subagent 于后台，汇回单一结果（如全库审计 + 第二轮交叉验证）。
- **Cross-session messaging**：一个会话向另一个会话直接发消息（如告警"你的改动破坏了我正在依赖的东西"）。
- **其它**：output styles（会话级角色/语气/格式）、code intelligence（LSP 符号导航 + 实时类型错误）、artifacts（会话输出发布为交互网页）。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M2 ⑦ memory | auto memory 的四类分类（user/feedback/project/reference）+ 显式策展规则（不从代码/指令中重复存）—— 我们记忆写入工具的分类与策展判据模板 |
| M2 ⑥ skill-system | 懒加载契约（元数据常驻、body 按需载入）+ 技能可跑在隔离上下文（fork） |
| M3 ⑪ subagents | 子 agent 配置三件套：便宜模型路由 + skills 预载 + 独立持久记忆目录 |
| M3 ⑯ plugin-system | 插件 = 目录 + manifest + 命名空间组件；**hooks 作为插件的一种组件**（生命周期事件订阅） |
| M4 交接协议 | cross-session messaging = 最轻量的 agent 间通信（会话 A 向会话 B 发消息），比完整协议先落地更实用；dynamic workflows = 高阶形态（agent 自己写编排脚本） |
| M0 ② 拆分 | `.claude` 目录布局（skills/agents/hooks/commands/output-styles/agent-memory）是扩展物组织的业界事实标准 |

## 链接

- https://code.claude.com/docs/en/features-overview （扩展面总览）
- https://code.claude.com/docs/en/memory （CLAUDE.md + auto memory）
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/plugins/overview
- https://code.claude.com/docs/en/claude-directory
