# Pi (badlogic / Earendil)

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/badlogic/pi-mono （TypeScript，MIT，34k+ stars；OpenClaw 构建于其上）
- 文档：https://pi.dev/docs/latest

## 简介

刻意**最小**的 agent harness：4 个工具（read/write/edit/bash）+ 千 token 内 system prompt，刻意不做 MCP/子 agent/plan mode/权限弹窗。所有缺失功能的逃生门都是同一个：**让 Pi 自己给你建** —— "self-extensible" 是项目的自我定位。

## 关键特性

- **自我扩展循环**：Pi 读自己的 docs + examples → 写 TS 扩展到 `~/.pi/agent/extensions/` → `/reload` 热重载 → 会话内新能力生效。文档明确写 "Pi can create extensions. Ask it to build one for your use case."。社区实践：一句两句需求，agent 自己研究自己的 API，多数一次实现成功。
- **扩展（extensions）**：TS 模块（jiti 直跑，免编译）：`registerTool` / `registerCommand` / `registerShortcut`；事件拦截（block/修改工具调用、注入上下文、定制 compaction）；`ctx.ui`（select/confirm/input/notify/自定义 TUI widget）；`pi.appendEntry()` 存跨重启的会话状态；`registerProvider`（自定义 provider/虚拟模型/MCP server）。
- **发现与包**：`~/.pi/agent/extensions/`（global）/ `.pi/extensions/`（project）；目录 `package.json`（`pi.extensions` 字段）声明入口；扩展/技能/prompt/主题可打包成 package，经 npm 或 git 分发。
- **会话树（session tree）**：会话是**树** —— branch = 某点会话状态的完整 fork（独立上下文/工具调用/推理）；分支完成后主会话 rewind 并摘要分支成果。用例：分支跑 code review，结论带回主线，review 开销不污染主上下文。
- **使用形态**：交互 TUI / print / JSON mode / RPC / TypeScript SDK。
- **设计哲学**：每个焊进 core 的功能都是模型不能再自由推理的功能；core 保持最小，让 agent 维护自己的能力面。（社区批评：最小化也是天花板，自建预置认知成本。）

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M3 ⑯ plugin-system | 最极端形态：扩展 = 代码（全权限 TS 模块，无 sandbox）。设计决策可做**双轨**：声明式 manifest（安全、可移植）+ 受信代码扩展（强能力）—— Pi 证明后者可行且好用 |
| 自我进化（新候选项） | 不需要训练的自进化具体路径：读 docs → 写扩展 → 热重载；我们的 agent 在 M3/M4 可基于自家工具注册表 + docs 做同样的"给自己建能力" |
| session-fork | 会话树（branch + rewind + 摘要）是 session-fork 的完整形态：fork 干活、成果带回、不污染主线 |
| M0 ② 拆分哲学 | loop 本身保持极小，其余全挂扩展缝 —— 拆 AgentCore 时"core 留多少"的哲学参照 |

## 链接

- https://github.com/badlogic/pi-mono
- https://pi.dev/docs/latest/extensions
- https://kevinmhallett.com/blog/pi-coding-agent-self-extension （自我扩展实践记录）
