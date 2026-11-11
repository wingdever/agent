# OpenCode (sst)

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/sst/opencode （TypeScript，MIT）
- 文档：https://opencode.ai/docs

## 简介

会话驱动的 agent runtime：TUI + 无头 server + SDK 共享同一核心。**location** 概念把配置/agents/工具/文件系统绑定到一个目录，session 是 location 下的持久会话。

## 关键特性

- **Agent 体系**：primary agents（build=全工具、plan=受限，Tab 切换）；subagents（general/explore/scout，@mention 调用或主 agent 自动委托）。自定义 agent = Markdown 文件（`{agent,agents}/**/*.md`，frontmatter）或 `opencode.json` 条目（mode/model/prompt/tools 白名单）。
- **隐藏系统 agent**：compaction/title/summary —— 压缩、标题生成等后台自动化工作也是"agent"。
- **子会话**：subagent 产生 child session；TUI 提供父子会话导航键（进入子会话/循环/返回父）。
- **插件**：JS/TS 模块，事件订阅 + 自定义工具注册；本地目录或 npm 包加载。
- **MCP 客户端**：本地 stdio + 远程 HTTP/SSE；OAuth 流程；server 状态跟踪（connected/pending/disabled/failed/needs_auth）；工具命名空间化；调用前权限断言；工具变更事件触发注册表热重载。
- **Skills**：可复用 prompt 模板（slash 命令），本地文件或远程 URL 发现。
- **Commands**：配置/Markdown 定义 slash 命令（模板插值，可 spawn subagent 会话）。
- **LSP 集成**：diagnostics/hover/go-to-definition 作为 agent 上下文。
- **会话**：SQLite（Drizzle）；compaction/revert/interrupt；CLI `--continue` / `--session` / `--fork`；`opencode serve` 无头 + `--attach`（免 MCP 冷启动）；`opencode run` 一次性（可脚本化）；`opencode stats`。
- **配置级联**：global → project → `.opencode/` 目录（后者覆盖前者）。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M3 ⑪ subagents | 子会话模型（subagent = child session，可导航可检视）+ @mention 调用；压缩/标题等后台工作也做成 agent —— 我们轨迹面板可同样展示子 agent 子会话 |
| M0 ② 拆 AgentCore | `packages/core` 的 service 划分（location/session/agent/tool-registry/permission）是拆分粒度参照 |
| M3 ⑬ mcp | MCP 客户端工程细节：状态机 + 工具变更热重载 + 与权限 gate 的集成（调用前 assert） |
| M3 ⑯ plugin-system | JS/TS 插件路线（事件订阅 + 工具注册），与 Goose/Claude Code 的目录 manifest 路线形成两种格式对照，供设计决策 |
| session-fork | CLI 级 `--fork`（续接会话时派生分支） |
| 增强包 settings | 配置级联（global→project→local）是 per-project 设置的标准形态 |

## 链接

- https://github.com/sst/opencode
- https://opencode.ai/docs （agents / plugins / mcp / skills / cli）
