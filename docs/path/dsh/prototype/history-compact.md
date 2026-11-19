# history-compact（功能）

历史压缩：把较早的对话区间替换成一份结构化检查点，以腾出上下文空间。它与前面功能相反：**不注入，而是替换**。规则部分见 `communicate-contract.md` 的准入规则与 `system-prompt.md` 的组装规则。

## 1 它在什么时候出现

| 触发 | 发生时机 |
|---|---|
| 自动压力触发 | 成功 step 越过阈值后，在下一个候选 step 组装前判定 |
| 手动 `/compact` | 用户显式发起，在空闲会话上执行 |
| 溢出恢复 | 模型请求返回上下文超限错误，按替换后的表面重建一次重试 |
| 工具结果预剪 | 压缩前的可选步骤：oversized 工具结果先就地改写，若仍超阈值才做摘要 |

执行顺序：先由可选的 pruner 改写超长工具结果；若仍然需要，才调用摘要模型生成检查点。

## 2 它注入什么

压缩是**替换表面区间**：被选中的较早区间从派生历史里消失，换成一条检查点。检查点由前言、`<compacted-summary>` 标签、结构化摘要三部分组成：

```text
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step
## Critical Context
</compacted-summary>
```

各节的取值规则以摘要指令为准；摘要指令作为**最后一条 user 消息**发给摘要模型，不进入主会话：

```text
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

[八个固定小节，顺序与检查点一致]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

工具结果预剪把超长结果保留头尾、中间换成标记：

```text
[... tool result middle pruned ...]
```

## 3 它如何配合规则

- **替换而非追加**：检查点取代被选中的区间，后续请求的输入历史因此变小，而不是多出一份副本。
- **边界**：只选当前表面上的连续区间，且不能切断工具调用与结果的配对；`system/message` 头部节点从不被选入。
- **对系统提示词的影响**：若某次压缩把 system 节点一起移除，下一次准入会重新写入（按 `communicate-contract.md` 的准入规则）。
- **对运行时上下文的影响**：快照被吸收后，下一次合格请求会重发（见 `runtime-context.md`）。
- **KV Cache**：替换会从第一个被替换的 token 起失效，替换区间之前的请求前缀仍可复用。

## 4 组合条件

- 与 `compaction-tool-result-pruner` 同时存在时，pruner 先跑；否则直接做摘要。
- 与会话标题、翻译等辅助请求互不影响：它们各自带独立提示词，不写主会话表面。
- 摘要路由可配置：默认复用主会话的系统提示词与工具声明作为前缀。
