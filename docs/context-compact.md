# 上下文压缩（compaction / `/compact`）

> 复刻 DeepSeek Harness (DSH) 的上下文压缩方式。DSH 侧的事实来源：
> `reference/deepseek-harness/packages/compaction/*`、`docs/subsystems/compaction.md`。
> 本文记录本项目的语义、数据结构、触发策略、实现链路，以及与 DSH 的异同。
> 事件溯源的背景概念见 [event-sourcing.md](event-sourcing.md)。

## 0. 概念：log / surface / transcript / summary / checkpoint

| 概念 | 含义 | 本项目落点 |
|---|---|---|
| **log** | 只追加的原始记录，压缩永不改写 | `messages` / `calls` / `contents` 表 |
| **surface** | 模型可见的投影：回放 log + 压缩 replace 后得到的消息序列 | `getSurface()`（[store.mjs](../core/storage/store.mjs)） |
| **transcript** | 人类阅读的投影：读 append-origin 消息，压缩区仍显示原文 | UI 的 chat 视图 |
| **summary** | 模型写出的 8 段 Markdown 正文 | `compaction/summary` 事件的 `data.summary` |
| **checkpoint** | 承载 summary 的那条 **user 消息**：preamble + 标签 + summary + 来源标记；它是 surface 节点 | `user/message` 事件 + surface replay |
| **boundary（切点）** | 本次压缩最后一条被替换的 surface 节点 seq | `compaction/summary` 的 `shadowedRange.end` / `shadowedSeqs` |

### 0.1 三个容易混的「checkpoint」

1. **summary**：模型写的正文（本回答常说的「摘要」）。
2. **checkpoint message**：`frameCheckpoint(summary)` 之后落回 surface 的 user 消息；
   下一个模型看到的是它，不是裸 summary。
3. **checkpoint record / boundary**：`compaction/summary` 事件里的 `shadowedRange` /
   `shadowedSeqs` / 边界位置，以及 UI 卡片所指的「压缩到哪」。

关系：**record 记录「切了哪段、摘要是什么」；summary 是 record 里的正文；
checkpoint message 是加了框、投到 surface 的那封信。**

### 0.2 summary 与 checkpoint 的结构关系

```
模型输出（summary）:
## Primary Request and Intent
- ...

        │ frameCheckpoint(summary)
        ▼

checkpoint（surface 上的一条 user 消息）:
This is an automatically generated checkpoint condensing an earlier span ...
Treat the captured context as established background ...

<compacted-summary>
## Primary Request and Intent
- ...
</compacted-summary>
```

- **包含**：checkpoint = preamble + `<compacted-summary>` + summary + `</compacted-summary>`；
- **计量**：`tokensAfter` 按 framed checkpoint 算（不是裸 summary），preamble/标签的开销计入
  「摘要必须比原文小」的判定；
- **消费者**：模型读 checkpoint；UI 卡片显示 summary；transcript 两者都不显示（仍显示原文）。

### 0.3 为什么要多这一层框

1. preamble 告诉下一个模型「这是既定背景，不要确认/复述」，避免它把摘要当成新的用户指令；
2. `<compacted-summary>` 标签让再次压缩时能识别「上一份 checkpoint」，按指令合并而不是照抄；
3. `source: {kind:'plugin', plugin:'compact', compactionId}` 让消费者无需解析正文就能认出压缩产物；
4. 计量口径：checkpoint 才是真正占请求 token 的东西，框架开销必须计入。

## 1. 一句话语义

把「模型看到的历史」中较老的一段，替换成**一条模型写的 framed checkpoint 消息**；
最近的历史原样保留；原始消息永不改写，只改变读取时的投影。

- **log** = `messages` / `calls` / `contents`，append-only；
- **surface** = 事件回放：append-origin 消息按 `seq` 叠加每次压缩的 `replace`，
  得到 `checkpoint + 保留尾部`；
- **transcript** = UI chat 视图：仍展示全部原始 turns，checkpoint 以卡片标在边界消息之后。

## 2. 触发方式

| 触发 | 时机 | 保留策略 | 说明 |
|---|---|---|---|
| 手动 `/compact` | 会话 idle（无 running turn） | `retainTokens=0`：只留**最后一个 balanced surface 节点** | 与 DSH `selectCompactableRange` 字面一致；通常最后一条 user 请求也会进入摘要 |
| 自动压力（pressure） | **每个 step 请求前** | 从尾部累积到约窗口 **16%**，切在最近的 balanced 位置 | 阈值 = 窗口 × 80%；切点可落在 turn 内部 |
| 上下文超限（context-overflow） | 模型返回 context-length 类错误后 | 同手动：留最后一个 balanced surface 节点 | 先 prune 再 summary；成功后重试该请求一次 |

上下文窗口解析顺序：`providers.json` 模型可选 `context_window` → `settings.contextWindow` → `128000`。
UI 的占用环使用同一个 `contextWindow` RPC，不再硬编码。

自动压缩可用 `settings.autoCompact` 关闭（默认开）；关闭后只剩手动 `/compact`。

## 2.1 compact 之后发给模型的请求

以 Chat Completions 为例：

```json
{
  "model": "...",
  "messages": [
    { "role": "system", "content": "会话 system prompt（+ 当前 plan-mode policy）" },
    { "role": "user", "content": "<preamble>\n<compacted-summary>…summary…</compacted-summary>" },
    "…保留的 surface 消息（user / assistant / tool，按原顺序）…",
    { "role": "user", "content": "（可选）@ 引用的文件/会话块" },
    { "role": "user", "content": "本轮新输入（若开启翻译，是英文译文）" }
  ],
  "tools": ["…工具 schema…"],
  "stream": true,
  "reasoning_effort": "…（若 effort 生效）"
}
```

- **工具不在 messages 里**，是 payload 的独立 `tools` 字段；
- `@` 引用块是临时注入的 user 消息，不落库，因此不会出现在 checkpoint 里；
- 保留尾部可能包含 `assistant.tool_calls` + `tool.tool_call_id`，成对保留；
- 旧消息不再出现在请求里。

```
压缩前 surface:  [sys] [U1] [A1] [U2] [A2] [U3] [A3]
                          └──────── 被压缩 ────────┘  └保留┘
压缩后 surface:  [sys] [checkpoint(U1..U3)] [A3]
下一次请求:      [sys] [checkpoint] [A3] [新的 U4]
```

## 3. 压缩事务（DSH 事件格式）

每次压缩写四类 `session_events`：

1. `compaction/start`（`{compactionId, trigger, turn}`，带进程 `boot`）——**持久锁**；
2. `compaction/summary`（`summary / shadowedRange / shadowedSeqs / shadowedTokenCount /
   tokensAfter / provider / model / maxTokens / turns / boundaryMessageId / boundaryTurnSeq`）；
3. `user/message`：framed checkpoint + `source:{kind:'plugin', plugin:'compact', compactionId}`
   + `surfaceOp:{op:'replace', start, end}` + `sourceEventSeqs`；
4. `compaction/end`（成功无 error；失败带 `error`）。

`seq` 与 `messages.surface_seq` 共用一个 per-session 序列，所以 `shadowedSeqs` / `surfaceOp`
是真实事件序号。锁 = 同一 `boot` 内最新的 `compaction` 标记是未闭合的 `start`；进程重启后
旧 boot 的 start 自动失效（等价 DSH 的 `session/end-seed` 边界），无需启动时清理。

手动压缩进行中，core 用一个 per-session 闸门让新 turn 排队等待（DSH `runMaintenance` 的排队语义）；
反向（turn 在跑时手动 `/compact`）直接拒绝并提示需要 idle。

失败一律 **fail closed**：写 `start` + `end{error}`，没有 summary/replace，surface 不变；
手动命令把错误返回给 UI，自动压缩只告警并继续本轮请求。

## 4. 摘要格式

逐字沿用 DSH：

- 指令作为**最后一条 user 消息**追加在被压缩区间之后（前缀缓存复用）；
- 输出固定 8 段 Markdown：Primary Request and Intent / Key Technical Concepts / Files and Code /
  Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context；
- 落回 surface 的消息形如：preamble + `<compacted-summary>` + summary + `</compacted-summary>`。

## 4.1 摘要覆盖范围：第一次 vs 再次压缩

摘要覆盖的是**切点之前的所有历史**，不是整个会话，也**不包含保留的尾部**：

```
第一次压缩:
  shadowed = U1..U3（全部更早历史）
  summary  = 这些内容的摘要
  surface  = [checkpoint(U1..U3)] + [A3]

再次压缩:
  surface before = [CP1] [A3] [U4] [A4] [U5] [A5]
  shadowed = CP1 + A3 + U4 + A4 + U5
  summary input = 旧 checkpoint 的完整消息 + 这次新切掉的消息
  new summary = 合并（保留仍为真的事实、丢弃过时内容）
  surface  = [CP2] + [A5]
```

- 是**累积摘要**：旧 checkpoint 会被喂回模型，所以更早的历史以摘要形式被继承；
- 以前保留过、但被新切点越过的消息，会被折叠进新摘要；
- **当前保留尾部永远不进摘要**，直到下一次切点越过它；
- surface 最多只有一份 checkpoint：新 replace 会替换掉头部的旧 checkpoint。

## 4.2 实现链路（读代码顺序）

1. `getSurface()`：append-origin 消息 + 按 seq 应用 replace，得到节点；
2. `surfaceCuts()`：计算每个切点是否平衡；
3. `selectTailBoundary()` / `selectAutoBoundary()`：选最后一条被压缩的节点；
4. `_surfaceNodes()`：给节点补 token 价格；
5. `_runCompaction()`：
   `compaction/start` → `_summarizeMessages()` → 尺寸校验 →
   `compaction/summary` → `user/message(replace)` → `compaction/end`；
6. `_requestMessages()`：回放后的 surface + pending，拼成下一次请求；
7. `compactSession()`（手动）与 `_maybeCompactStep()`（自动/overflow）是两条入口，
   共用第 5 步。

## 5. 区间选择（消息级 surface + tool-pair 平衡）

surface 是逐条消息的节点序列（user / assistant / tool），外加 head 处上一份 checkpoint
作为合成节点。`surfaceCuts()` 逐节点计算：assistant 的每个 tool_call 加一、每个 tool result
减一，计数为 0 才平衡。选中的边界是**最后一条被压缩的 surface 节点的 seq**。

- **手动 / 超限**：`selectTailBoundary(nodes)` = `retainTokens=0` —— 保留最后一个 balanced unit，
  其余全部压缩；只有一个节点时返回 null；
- **自动**：`selectAutoBoundary(nodes, retainTokens, extraTailTokens)` —— 从尾部累积到预算，
  再把切点回退到最近的平衡位置；未落库的 pending user 消息通过 `extraTailTokens` 计入预算，
  但永不参与压缩。

边界可以落在 turn 内部；被压缩的前缀在请求投影里替换为 checkpoint，原始消息仍在存储与
transcript 中。上一份 checkpoint 也是 surface 节点，因此剩余 surface 只有一个节点时，
再次压缩会重写该 checkpoint（DSH 允许的行为）。

## 6. tool-result pruner

模型无关的确定性裁剪，沿用 DSH 默认值：

- `thresholdChars 8192`、`headChars 4096`、`tailChars 1024`（Unicode code points）；
- 中间替换为 `[... tool result middle pruned ...]`；
- 结果写入 `tool_result_prunes`（原始 `messages`/`contents` 不动），surface replay 时替换；
- 只在自动压力/超限路径执行；手动 `/compact` 不 prune（与 DSH 一致）。

## 7. token 计量（DSH token-meter）

- **per-node**：`ceil(chars / 4)` + 每条消息 4 + 每块 4（工具调用按 name/arguments 计价）；
- **header**：system prompt + tool schemas 的估价；
- **usage 锚点**：每次成功响应后记录 canonical header 的 sha1、请求 surface 的估价、回复估价、
  provider usage。下一次测量时，若 header 未变且 usage ≥ 该请求的完整启发式价格，则
  `total = usage + (当前 surface - 锚定 surface)`；否则整包重新估价。
  模型 / system / tools 任一变化都会让锚点失效。

route-specific image pricing 在本项目等价于 DSH 的无图片回退（消息是纯文本），因此不做。
底部状态栏仍显示 provider 的 usage，计量值只用于压缩阈值与 `~N tokens` 报告。

## 8. 与 DSH 的异同

### 8.1 已对齐

- 手动 `retainTokens=0`：只留最后一个 balanced surface 节点；
- 自动切点：按 token 预算、可切入 turn 内部，切点回退到 tool-pair 平衡处；
- 摘要 prompt / 8 段结构 / `<compacted-summary>` 标签 / preamble / 再次压缩合并规则；
- 摘要调用重放 system + tools + 区间消息，`max_tokens 8192`，一次性非流式；
- fail closed（空文本 / tool_calls / 不比原文小 / 请求失败都不改 surface）；
- `compaction/start → summary → user/message(replace) → end` 事件格式、`shadowedSeqs`、
  `shadowedRange`、`sourceEventSeqs`、`source:{plugin:'compact'}`；
- 锁 = 同 boot 内未闭合 start；失败留 `end{error}`；进程重启旧 start 自动 stale；
- transcript 保留全部原始消息；checkpoint 只改变模型视角；
- token meter：per-node + header + provider usage 锚定；
- tool-result pruner 默认参数与「手动不 prune」；
- 无 undo（append-only 语义）。

### 8.2 刻意保留的差异

| 维度 | DSH | 本项目 | 原因 |
|---|---|---|---|
| 消息存储 | 一切消息都是事件，surface 从事件派生 | `messages` 关系表 + `surface_seq`；只有压缩事件进 `session_events` | 中间态：压缩子系统事件化，避免重写 turn/step/message 与 UI |
| 事件日志范围 | 全部 session 事件（turn/step/message/request header/usage…） | 只记录压缩四类事件 | 同上；轨迹/回放仍读关系表 |
| 取消 | AbortSignal 贯通 summarization | 无 | 本项目没有请求中断基础设施 |
| 图片 route pricing | 支持按路由给图片定价 | 纯文本，等价无图片回退 | 消息 content 是字符串 |

### 8.3 仍未实现

- 完整 event sourcing（turn/step/message 全部事件化、全量 replay）；
- 压缩的取消（AbortSignal）；
- 可选的 `compaction-tool-result-pruner` 作为独立可插拔服务（当前内置在压缩流程里）。

## 9. 边界与坑

1. **短会话会失败**：preamble + 8 段摘要本身有固定开销，历史太短时
   `tokensAfter >= tokensBefore`，fail closed（UI 提示「历史太短」）。
2. **checkpoint 自身也能被重写**：surface 只剩 checkpoint + 一条消息时，再压会只替换
   checkpoint（`shadowedRange` 指向自己），`turns=0`。
3. **`shadowedRange.start > end` 是合法的**：它是位置跨度，不是数值区间；replay 用
   `findIndex(seq)`，不要用数值比较校验。
4. **估值 vs 真实 usage**：计量是启发式 + 锚点；底部状态栏仍显示 provider usage，两者口径不同。
5. **`@` 引用是临时的**：不落库，压缩重建的历史里没有它；这是既有设计，不是压缩 bug。
6. **锁不要用「有没有 start 事件」判断**：要看「最新 start/end 标记 + boot」，否则上次进程
   崩溃留下的 start 会永久占锁。
7. **r=0 的时序**：自动压缩在 step-0 落库前检查，当前 user 消息以 `extraTailTokens` 计入保留
   预算、永不参与压缩；DSH 的 pre-step 时 user 已落库，这是小的时序差异。

## 10. 验证方式

- `node --test test/compaction.test.js`：估算 / pruner / surfaceCuts / 区间选择 / framing /
  overflow 正则 / surface replay / boot 锁 / token 锚定 / 手动事务 / 自动重建，共 14 例；
- 三个端到端 smoke（本机脚本）：自动压力压缩、context-overflow 恢复、连续两次压缩；
- HTTP 路径：`compact` 走 SSE，事件流为 `compaction:start` → `compaction:done` → `result`。

## 11. 代码位置

- `core/compaction.js`：估算、pruner、surfaceCuts、区间选择、framing、DSH prompt、overflow 正则；
- `core/token-meter.js`：header 估价、canonical header key、usage 锚定测量；
- `core/index.js`：`compactSession` / `_maybeCompactStep` / `_runCompaction` / `_requestMessages` /
  `_surfaceNodes` / `_summarizeMessages` / `_pruneToolResults` / `_recordTokenAnchor`；
- `core/storage/{schema,store}.mjs`：`session_events`、`messages.surface_seq`、`tool_result_prunes`、
  `token_anchors`、`getSurface()` replay、boot 锁判定；
- `core/transports/http.js`：`compact` 走 SSE，末尾用 `result` 事件回传结果；
- `ui/web/app.js`：`/compact` 拦截、checkpoint 卡、状态提示、轨迹标记、`contextWindow`；
- `ui/web/settings.js`：`autoCompact` 开关；
- `test/compaction.test.js`：上述 14 例。

复刻自 DSH（MIT License）的原文提示词与默认参数，仅做适配。
