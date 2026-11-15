# Aider

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/Aider-AI/aider （Python，Apache-2.0）
- 文档：https://aider.chat/docs/

## 简介

最老的开源终端 pair-programmer（2023）。两个思想后来成为行业标准：**repo map**（token 预算约束的全库代码地图）与 **architect/editor 双模型**分工。

## 关键特性

- **Repo map**：tree-sitter 抽每文件符号定义/引用 → 建文件依赖图 → **Personalized PageRank**（个性化向量偏重当前 chat 文件、被提及文件、路径匹配）→ 按 token 预算（`--map-tokens` 默认 1k；无 chat 文件时显著扩大，默认 ×2）渲染"全库最重要类/函数 + 签名"地图，随每次请求发送。SQLite 缓存 + mtime 失效。
- **编辑格式（edit formats）**：whole / diff / diff-fenced / udiff / patch，每个模型调校到它守得住的格式 —— "测出每个模型守得住哪种输出契约，把模型路由到它守得住的契约"。
- **Architect/editor 双模型**：architect（强推理模型）只提方案（想怎么描述就怎么描述）→ 用户确认门（"Edit the files?"）→ editor（便宜模型）转成具体文件编辑；编辑 benchmark SOTA 配置（o1-preview + DeepSeek/o1-mini，85%）。
- **模式**：code / ask（只读问答）/ architect / help，按消息切换（`/code`、`/ask`、…）。
- **弱模型**：`--weak-model` 把 commit message 生成、chat 历史摘要交给便宜模型 —— 廉价工作用便宜模型。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M4 代码专门 agent | repo map 作为代码 agent 的标配上下文工程（tree-sitter + 图排名 + 预算约束）：不必读全文件，模型可见全库签名并知道该读哪些文件 |
| M4 模型路由 | "任务类型 → 模型"映射纪律：推理类用贵模型，编辑/commit/摘要类用便宜模型 |
| M1 ⑤ goal-auto-continue | architect → 用户确认门 → editor 三段 = "规划-确认-执行"循环，与我们 plan mode → build-code 流转同构（确认门即我们的 plan-review） |
| M0 ② | 按模型调校输出格式的纪律：不假设通用输出契约（我们工具返回结构化结果时可按模型差异调校） |

## 链接

- https://github.com/Aider-AI/aider
- https://aider.chat/docs/repomap.html
- https://aider.chat/docs/usage/modes.html
- https://aider.chat/2024-09-26-architect.html
