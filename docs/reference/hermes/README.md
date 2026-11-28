# Hermes 实现系列

> 源码基线：`reference/hermes-agent`，`main` @ `337903eeffd696cf73936a3a00af08b43feb2028`。
>
> 这组文档只回答一个问题：**Hermes 到底是怎么实现的**。产品能力介绍、与我们的架构对比、改进优先级，分别留在 `docs/reference/hermes.md` 和 `docs/reference/hermes-architecture-comparison.md`。

## 这套文档是什么

`docs/reference/hermes.md` 是“Hermes 有什么能力”的摘要；`docs/reference/hermes-architecture-comparison.md` 是“我们和它差在哪、先改什么”的评审。这组 `docs/hermes/` 则往下钻一层：

- 关键机制的真实源码路径；
- 关键提示词、schema、状态机的原文或准确摘录；
- 设计不变量，以及它们分别在防什么事故；
- 最后一节统一给出“对我们项目的最小实现”，但不把 Hermes 的复杂度整体搬过来。

## 范围

本枝按机制分篇：记忆、prompt 缓存、工具面、上下文压缩、gateway 与投递、skills 生命周期、委派与 cron。每篇只写已经读完源码、能落到具体文件的部分；没有写的机制不预建空文档。

## 写作约定

1. **Hermes 事实和我们的判断分开写。** 前者给源码路径与原文；后者明确标“建议/判断”，不混在引用里。
2. **提示词尽量原文。** 提示词是行为契约，转述会丢约束；长提示词只摘与主题相关的段，并标文件名。
3. **每篇都有“最小实现”。** 只写能落地的 1–3 个动作，不复制整套 provider/plugin/线程治理。
4. **不把 Hermes 的规模当目标。** 它是多平台消费级产品，我们是本地开发工作台；对照的是机制，不是体量。

## 建议的源码阅读顺序

1. `AGENTS.md`、`agent/AGENTS.md`：先拿住 prompt cache 与核心窄腰两条不变量。
2. `agent/system_prompt.py`、`agent/prompt_builder.py`：看清 stable / context / volatile 三层。
3. `tools/memory_tool.py`、`tools/memory_tool_store.py`、`agent/background_review.py`：记忆的读写与学习回路。
4. `tools/AGENTS.md`、`toolsets.py`：工具面与能力边界。
5. `gateway/AGENTS.md`、`gateway/delivery_ledger.py`、`gateway/session_identity.py`：多平台与投递可靠性。
6. `agent/conversation_compression.py`、`turn_context_compaction.py`：压缩链路。
7. `cron/AGENTS.md`、`agent/delegation_context.py`：自动化与委派。
