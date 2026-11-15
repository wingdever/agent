# Gemini CLI (Google)

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/google-gemini/gemini-cli （TypeScript，Apache-2.0）
- 文档：https://google-gemini.github.io/gemini-cli/docs/

## 简介

Google 的开源终端 agent，免费额度友好。扩展生态成熟（官方样板 + 社区市场），是开源项目里"manifest 式扩展"格式的最直接参照。

## 关键特性

- **GEMINI.md 层级记忆**：global（`~/.gemini/GEMINI.md`）→ project 及祖先目录（至 `.git` 根）→ 子目录（**just-in-time**：工具实际访问该目录时才加载，尊重 .gitignore/.geminiignore）；`@file.md` import 把上下文文件模块化；footer 显示已加载上下文文件数。
- **`/memory` 命令族**：show（拼接后的完整指令文本）/ add（追加到 global）/ refresh（重扫）/ list —— 用户随时可检视与管理模型实际收到的指令。
- **`contextFileName` 可配置**：`settings.json` 可设多个上下文文件名（如 `["AGENTS.md","CONTEXT.md","GEMINI.md"]`），直接兼容 AGENTS.md 惯例。
- **扩展（extensions）**：`gemini-extension.json` manifest（name/version/mcpServers/contextFileName/excludeTools），一个目录捆绑 MCP servers + 自定义命令（TOML）+ 上下文 + agent skills + hooks + 主题；`gemini extensions install <github-url|本地>` / update / link（开发模式）；`${extensionPath}`/`${workspacePath}` 变量；命令名冲突时扩展自动加前缀（`/gcp.deploy`）。
- **MCP**：stdio/SSE/HTTP；`/mcp` 检视 server 状态与工具 schema（Ctrl+T 切换描述显隐）。
- **Checkpointing**：`--checkpointing` 选项开启，`/restore [tool_call_id]` 把项目文件恢复到某次工具执行前状态。
- **模型路由**：自动 fallback 容错（model fallback resilience）；headless 模式；remote agent 连接。
- **扩展市场**：memory 类扩展最热门（deja-vu：跨 harness 会话搜索，含 Claude Code/Codex/Cursor 的历史会话；compartment：离线加密记忆库；ultramemory：跨产品记忆 + 反幻觉门）。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M2 ⑦ memory | just-in-time 子目录上下文（碰到 `packages/x/` 才加载其指令）—— per-project 设置的懒加载形态；`@file` import 让记忆文件保持模块化；`/memory` 命令族（用户可检视模型实际收到的指令）适合放进 settings 增强项 |
| M3 ⑯ plugin-system | manifest 式扩展目录（与 Claude Code plugin 格式最接近）；`excludeTools` 是权限收窄的细粒度示例（可细到命令级，如 `run_shell_command(rm -rf)`） |
| M1 ④ session-save | `/restore` checkpoint（文件恢复到工具调用前）—— "挂起状态接续"的简单形态 |
| M3 ⑬ mcp | 扩展市场显示第三方需求排序：memory > database > 其它 —— 印证 memory gap 判断 |

## 链接

- https://github.com/google-gemini/gemini-cli
- https://google-gemini.github.io/gemini-cli/docs/extensions/
- https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html
