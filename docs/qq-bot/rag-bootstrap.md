# 资料采集与 RAG 冷启动

## 1 目标与边界

本设计的目标是在群内还没有足够聊天数据时，先用外部 Agent 开发资料建立一套**可引用、可版本化、可评测**的领域知识底座，让 QQ 群聊机器人从第一天就能回答常见问题。

需要明确两个概念：

- **领域知识底座**：来自官方文档、论文、工程博客等外部资料，回答“世界上有哪些做法”。只读、版本化、带来源。
- **群知识**：来自群内问答、纠正、管理员确认，回答“我们这个群该怎么做”。可编辑、需审核、按群隔离。

本设计只覆盖领域知识底座的采集、规范化、索引和检索；群知识卡片与用户画像使用独立存储，不混入外部资料库。

首版范围：

- 文本型资料：HTML、Markdown、GitHub README、纯文本 PDF；
- 主题限定在 Agent 架构、工具调用、检索与 RAG、评测与可观测性；
- 不覆盖扫描件 OCR、视频、音频和多模态资料；
- 不让 LLM 生成事实性文档进入正式索引。

## 2 总体结构

```text
源清单（人工批准）
  -> 查询计划
  -> URL 候选与分级
  -> 抓取与提取
  -> 规范化文档
  -> 切分、embedding、索引
  -> 检索与回答

独立存储：
  group_cards      群内已验证知识
  profile_claims   用户画像字段
  qa_events        问答日志与反馈
```

检索优先级：

```text
已验证群卡片 > 官方文档（T0） > 高质量外部资料（T1/T2） > 社区经验（T3）
```

设计原则：

- **Agent 在每段的边缘做判断，不做黑箱主链路。** 查询生成、来源分级、解析修复可以由 Agent 辅助；抓取、去重、快照、切分、索引保持确定性。
- **每段产出 typed artifact。** 每段结果落盘，可单独重跑、审计和替换。
- **生成内容与事实内容分离。** LLM 生成的提纲、问题、摘要只用于选题和评测，不进入 `verified` 索引。
- **平台只做检索与生成。** QQ 网关、引用格式、限流、审核和群卡片留在本项目。

### 2.1 产物契约

| 产物 | 生产者 | 消费者 | 关键字段 |
|---|---|---|---|
| `query_plan` | 查询规划 | URL 发现 | topic、query、intent、lang、source_filter |
| `url_candidates` | URL 发现 | 抓取器 | url、canonical_url、source_tier、status |
| `snapshots` | 抓取器 | 提取器 | snapshot_id、http_status、content_hash、raw_path |
| `documents` | 规范化 | 索引器 | doc_id、title、version、markdown_path |
| `chunks` | 索引器 | 检索器 | chunk_id、section_path、text、embedding |
| `qa_events` | QQ 网关 | 运营与评测 | question、answer、sources、feedback |

## 3 采集流水线

整体是“四段主链 + 两个质量段”：

- 主链：查询计划 -> URL 候选 -> 抓取提取 -> 索引编码；
- 质量段：前置的范围与源清单，后置的文档规范化。

### 3.1 范围与源清单

输入：主题、目标群画像、允许域名、版本范围。

输出：

- 主题树：把“Agent 开发”拆成若干可检索子主题；
- 源策略：允许域名、来源档位、语言、版本、许可证；
- 首版种子源：15–25 个高质量来源。

来源分档：

| 档位 | 内容 | 用途 |
|---|---|---|
| T0 | 官方文档、规范、官方指南 | 可作为事实依据 |
| T1 | 论文、官方工程博客 | 可作为技术依据 |
| T2 | 高质量团队/个人实践 | 作为实践参考，需标注 |
| T3 | 论坛、问答、碎片讨论 | 只作为线索，不作为唯一依据 |

规则：

- 新域名默认不进入采集队列，人工批准后放开；
- 同一主题至少有一个 T0 来源；
- 版本敏感的主题必须记录框架/模型版本；
- 不采集需要登录、付费墙或违反站点条款的内容。

生成内容边界：

- 可以让 Agent 生成主题树、查询计划、文档摘要、黄金问题、覆盖缺口；
- 不让 Agent 生成 API 用法、版本说明、最佳实践等事实性内容；
- 生成内容标记为 `source_type: generated`，只用于选题和评测，不进入 `verified` 索引；
- 生成摘要必须能回指原始文档，不能成为独立事实来源。

### 3.2 查询计划

输入：主题树、源策略。

输出：`query_plan`，不是自然语言句子列表。

```json
{
  "topic": "agent/tool-use",
  "queries": [
    {
      "q": "function calling tool use official documentation",
      "intent": "official",
      "lang": "en",
      "source_filter": "docs",
      "freshness": "current"
    },
    {
      "q": "MCP tool call error code",
      "intent": "troubleshooting",
      "lang": "en",
      "must_include": ["MCP"]
    }
  ]
}
```

查询类型：

- **概念查询**：是什么、为什么、怎么做；
- **精确查询**：API 名、配置项、错误码、版本号；
- **官方源查询**：限定官方文档、GitHub、arXiv、sitemap；
- **对比与迁移查询**：版本差异、替代方案、迁移路径。

规则：

- 每个子主题生成 3–5 条不同意图的查询，不生成大量近义句；
- 查询必须带 `intent`、`lang`、`source_filter`，便于后续判断命中质量；
- 记录每条查询命中的 URL 数、批准数、有效率；
- 低产出查询要淘汰，不能只增不减。

Agent 负责生成和扩展查询；是否允许某个域名由人决定。

### 3.3 URL 候选与分级

输入：搜索结果、官方 sitemap、GitHub API、arXiv API。

输出：`url_candidates`。

```text
url, canonical_url, title, source_tier,
version (可先留空，抓取后补), discovered_by_query,
search_rank, status: candidate / approved / rejected
```

处理步骤：

1. 跟随重定向，拿到最终 URL；
2. 去掉 `utm_*`、`ref` 等追踪参数；
3. 优先官方 canonical：官方文档、GitHub raw、arXiv abs、站点 sitemap；
4. 用标题、canonical、域名关系识别镜像候选；抓取后再用 `content_hash` 确认；
5. 标注来源档位、语言、主题、候选版本；
6. 新域名进入人工审批，不自动抓取。

规则：

- 搜索结果只是候选，摘要不能当正文；
- 同一内容只保留一个 canonical 记录；
- 搜索结果排名不等于可信度；
- 旧版本页面保留，但必须带版本标签，检索时可按版本过滤。

### 3.4 抓取与提取

抓取和提取分开。

**抓取**负责：

- HTTP 状态、内容类型、编码、重定向；
- 限速、重试、超时、缓存；
- 原始 HTML/PDF 快照；
- `fetched_at`、`http_status`、`content_hash`。

**提取**负责：

- 正文、标题、作者、发布时间；
- 标题层级、代码块、表格、链接；
- 转成 Markdown；
- 许可证与版权信息。

工具优先级：

- HTML：Readability / Trafilatura 提正文，再转 Markdown；
- PDF：Docling、MinerU 等版面解析；
- GitHub：raw Markdown 或 API，不抓渲染页；
- JS 页面：Playwright 只做兜底，不默认使用浏览器。

Agent 只在正文提取失败、代码块被截断、表格被压平时介入。它输出修复建议，不直接覆盖原始快照。

失败模式：

- 反爬或登录墙：记录失败，不绕过；
- 正文为空：回到 URL 分级，检查是否选错页面；
- 代码块断裂：按代码块重新提取；
- 语言不匹配：标记并跳过，避免中英混库；
- 内容截断：保留快照，标记 `partial`。

### 3.5 规范化

输入：原始快照和提取结果。

输出：`documents` + manifest。

```text
doc_id, canonical_url, snapshot_id, content_hash,
title, publisher, version, published_at, language,
markdown_path, topic, trust_tier, license
```

质量检查：

- 正文不是空壳，不含大量导航、页脚、推荐阅读；
- 代码块完整，语言标记正确；
- 表格没有被压成一行；
- 标题和正文主题一致；
- 版本号与资料内容一致；
- 同一 URL 的 hash 变化能触发增量更新；
- 正文语言与声明语言一致。

规范化后的文档是索引的唯一输入。原始快照只用于审计和重跑。

### 3.6 索引编码

输入：规范化文档。

输出：`chunks` + 向量索引 + 关键词索引。

流程：

```text
documents
  -> 结构感知切分
  -> chunk 元数据
  -> embedding
  -> 向量索引 + BM25/FTS
  -> collection_version
```

切分规则：

- 按标题层级切分，chunk 前带 `文档标题 > 章节路径`；
- 每块 400–800 tokens，重叠 10%–15%；
- 代码块单独成块，保留语言和上下文；
- 表格转 Markdown 或结构化文本，不切碎；
- 同一文档的近邻 chunk 保留 `prev/next`，命中后可扩展上下文。

索引规则：

- 索引和查询必须使用同一个 embedding 模型；
- 每次索引带 `collection_version`，例如 `agent-dev-v1`；
- 文档变化只重索引变化的 chunk；
- 同时保留向量索引和关键词索引，精确术语走 BM25；
- 中文语料的 FTS 需要支持中文分词，否则关键词召回会明显偏弱；
- 索引是派生数据，可随时从 `documents` 重建。

Agent 在这里只做元数据补全和评测问题生成，不生成知识条目。

## 4 数据模型

```text
sources
  source_id, canonical_url, domain, trust_tier,
  topic, license, status

query_plans
  query_id, topic, query_text, intent, lang,
  source_filter, freshness, created_by

url_candidates
  url_id, query_id, url, canonical_url, title,
  source_tier, search_rank, status

snapshots
  snapshot_id, url_id, fetched_at, http_status,
  content_hash, raw_path

documents
  doc_id, snapshot_id, canonical_url, title, publisher,
  version, published_at, language, markdown_path,
  topic, trust_tier, license

chunks
  chunk_id, doc_id, section_path, chunk_index,
  text, token_count, code_lang, embedding

group_cards
  card_id, group_id, kind, claim, evidence_json,
  status, confidence, approved_by, valid_to, supersedes

profile_claims
  claim_id, bot_id, user_openid, group_id, field,
  value, source, confidence, visibility, expires_at

qa_events
  qa_id, group_id, thread_id, question, answer,
  sources_json, feedback, created_at
```

关键约束：

- `canonical_url` 唯一；
- `content_hash` 用于去重和变更检测；
- `doc_id` 稳定，`snapshot_id` 可多版本；
- `chunk_id` 不跨版本复用；
- 群卡片和画像不写进 `documents`，避免外部资料与群内记忆混库。

## 5 RAG 选型

| 项目 | 定位 | 冷启动成本 | 适合场景 | 主要风险 |
|---|---|---|---|---|
| FastGPT | 中文知识库问答平台 | 低，2C/4G 可跑平台本体 | 中文优先、chunk 可调、混合检索、API | 许可证有附加条款 |
| RAGFlow | 深度文档理解 RAG 引擎 | 中，4C/16G 起 | 复杂 PDF、表格、扫描件、引用溯源 | 部署重，纯 Markdown 场景偏重 |
| Dify | LLM 应用平台 | 低到中 | 还需要工作流、运营后台、多模型编排 | RAG 深度一般，许可证有附加条款 |
| AnythingLLM | 本地文档问答 | 很低 | 单团队原型、桌面部署 | 不适合多群生产 |
| LlamaIndex / Haystack | 代码框架 | 高 | 长期自研、深度定制检索 | 解析、索引、评测都要自己写 |

当前选择：

- 首版优先 **FastGPT**：中文友好、部署轻、支持混合检索与重排、提供 API，适合先验证回答质量；
- 如果语料以复杂 PDF/表格为主，改用 **RAGFlow**：解析和引用更强，Apache 2.0 更干净；
- 如果还要做审核后台、定时任务和多步骤工作流，再考虑 **Dify**；
- 需要把群卡片和检索深度整合时，再转向 **LlamaIndex/Haystack** 自研。

资源口径：

- 2C4G 指 2 核 CPU、4GB 内存，不含磁盘和带宽；
- 2C4G 只适合跑平台本体，embedding/rerank 走 API；
- 单群试用可用 2C4G；多群或多人并发建议 4C8G 起；
- 本地部署 embedding/rerank 模型需要更高配置，通常单独一台带 GPU 的机器；
- RAGFlow 官方建议 4 核 16GB、50GB 磁盘起步。

许可证：

- 自建单群使用，FastGPT/Dify 的附加条款通常可接受；
- 如果做成多社区群 SaaS，需确认多租户授权和 LOGO/版权条款；
- RAGFlow 为 Apache 2.0，商用限制最少，但底层依赖需单独核查。

模型分工：

| 环节 | 模型 | 作用 |
|---|---|---|
| 索引与查询 | Embedding | 文档和问题转向量，负责召回 |
| 精排 | Reranker | 对召回结果重新打分，负责前几条准确率 |
| 生成 | LLM | 基于检索上下文回答，兼做查询改写 |
| 解析 | OCR/版面/表格模型 | 仅在 PDF/扫描件场景使用 |

首版推荐：

- Embedding：中英混合优先 BGE-M3 或 multilingual-e5；
- Reranker：bge-reranker-v2-m3 一类 cross-encoder；
- LLM：中文强、成本可控的模型；
- 解析：先只收 Markdown/HTML/文本 PDF，不上 OCR。

## 6 检索与回答策略

检索输入：

- 当前问题；
- 当前线程前 3–5 条消息；
- 群 ID、发言者 ID；
- 主题与版本过滤条件。

检索流程：

1. 查询归一化，保留 API 名、错误码、版本号；
2. 群卡片检索；
3. 领域资料混合检索：BM25 + 向量，RRF 融合；
4. 元数据过滤：`trust_tier`、`version`、`language`、`topic`；
5. rerank 到 top 5；
6. 必要时做 MMR，避免同一文档占满上下文。

回答策略：

- 已验证群卡片优先；
- 官方文档次之；
- T2/T3 资料明确标注“社区经验”；
- 每个关键结论带 1–3 个来源；
- 资料冲突时并列说明，不强行选一个；
- 没有可靠来源时直接说“没找到足够可靠的资料”；
- 代码给版本和来源，不把旧 API 当通用写法。

上下文边界：

- 检索结果只作为参考数据，不作为指令执行；
- 外部网页内容要清洗脚本、广告和注入文本；
- 不因为文档里写了“忽略之前指令”就改变系统行为；
- 不把用户画像中的私密事实写进群回答，画像只影响语气、长度和举例方式。

## 7 QQ 接入约束

官方 QQ 机器人默认只推送 `GROUP_AT_MESSAGE_CREATE`，即只有 @ 机器人时可见。群主开启“接收群内全部消息”后，才会推送 `GROUP_MESSAGE_CREATE`。

这意味着：

- 只有 @ 模式：先做问答型知识库，不做被动群聊沉淀；
- 全量模式：才能做被动抽取，但需要群主授权和群内告知；
- 个人主体机器人目前不支持公开使用，只能加入自己是群主/管理员的群；多社区群需要企业主体；
- 群聊被动回复有 60 分钟内 5 次限制，主动推送有每分钟和每日配额，采集与生成必须异步；
- 平台可能重复推送同一 `msg_id`，入库必须去重；
- 不同 AppID 的 `openid` 不同，用户主键用 `bot_id + author.id`，群内成员键用 `group_openid + member_openid`，昵称只做展示。

首版只响应 @ 或明确的 `#问`，不主动接话；回答先给结论，再给短解释；代码太长时按需展开。

## 8 最小落地顺序

1. **手工源清单 + 确定性采集器**：20 个 URL，跑通抓取、转 Markdown、去重、快照、manifest。
2. **查询规划**：加 Agent 生成 `query_plan`，只评估“每条查询产出多少高质量 URL”。
3. **URL 分级**：加来源档位、canonical、镜像识别；新域名人工批准。
4. **规范化与索引**：用 FastGPT 或 RAGFlow 建首个 collection，准备 50–100 条黄金问题。
5. **QQ 网关**：只做 @ 触发、引用、限流、`qa_events` 记录。
6. **反馈闭环**：把高频未答问题和管理员纠正转成 `group_cards`，让群卡片逐步优先于外部资料。

## 9 验收指标

采集阶段：

- 抓取成功率；
- 正文提取成功率；
- 重复率；
- 元数据完整率；
- 从源更新到索引更新的延迟。

检索阶段：

- 黄金问题 recall@5；
- 引用准确率；
- 无答案识别率；
- 代码块完整率；
- p95 延迟与每千次问答成本。

群内阶段：

- 重复问题被知识卡片覆盖的比例；
- 回答被管理员纠正的比例；
- 过期卡片比例；
- 画像泄露事故数，目标为 0。

## 10 不做的事

- 不用 LLM 生成事实性文档进入 `verified` 索引；
- 不做无边界的全网站爬取；
- 不绕过 robots.txt、登录、付费墙或反爬；
- 不在首版上 GraphRAG/LightRAG；
- 不把整个知识库注入每次对话；
- 不让 RAG 平台直接充当 QQ 机器人；
- 不自动给群成员打人格标签或负面评价；
- 不把用户画像当作群聊公开信息。

## 11 外部依据

- QQ 群全量消息：https://bot.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html
- QQ 群事件与 @ 消息：https://bot.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/event.html
- QQ 机器人常见问题（个人主体、群权限）：https://bot.qq.com/wiki/bot_FAQ/
- QQ 消息频控：https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
- QQ OpenID 隔离：https://bot.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html
- RAGFlow 仓库与部署要求：https://gitee.com/infiniflow/ragflow
- FastGPT / RAGFlow / Dify 对比：https://juejin.cn/post/7702407629847347227
- R2R 维护状态：https://dreaming.press/posts/2026-06-23-best-open-source-rag-platforms.html
