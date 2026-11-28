# Hermes 用户记忆实现

> 源码基线：`reference/hermes-agent`，`main` @ `337903eeffd696cf73936a3a00af08b43feb2028`。
>
> 本文只讲 Hermes 的 `MEMORY.md` / `USER.md` 这一套内置记忆；外部的 Honcho、Mem0、Hindsight 等 provider 只在最后提一句，不展开。

## 0 一句话结论

Hermes 的记忆不是“一个向量库”，而是**两个有字符上限的 Markdown 文件 + 会话首轮冻结注入 + 低频后台复盘 + 写入审批门**。它解决的不是“记住所有对话”，而是“把跨会话仍然成立的事实，压缩进一个固定 token 预算”。

## 1 两个文件，不是两个数据库

| 文件 | 定位 | 默认上限 | 典型条数 |
|---|---|---|---|
| `MEMORY.md` | Agent 自己的笔记：环境事实、项目约定、工具怪癖、踩过的坑 | 2,200 字符（约 800 tokens） | 8–15 条 |
| `USER.md` | 用户画像：身份、偏好、沟通风格、对 Agent 的期待 | 1,375 字符（约 500 tokens） | 5–10 条 |

- 位置：`~/.hermes/memories/`（按 profile 隔离；我们的对应位置建议 `user/memory/`）。
- 格式：条目之间用 `§`（section sign）分隔；条目内部可以多行。
- 字符预算是**硬上限**，不是软提示。写入超限时工具直接报错，并返回当前条目，让模型在同一个 batch 里删/缩旧条目再加新条目。Hermes 明确不做“静默截断/自动压缩”。
- 两个文件都不是流水账；是“下一会话仍然值得占用 system prompt 的事实”。

### 文件是扁平 entry，不是 Markdown 小节

Hermes 没有规定 `MEMORY.md` 分几个小节、`USER.md` 分几个小节，也没有模板文件。解析器只做一件事：

```text
整份文件 --按 "\n§\n" 切分--> entry 列表
```

`MemoryStore._parse_entries` 按完整的 `\n§\n` 分割，去掉首尾空白和空条目；`_render_block` 在 system prompt 里临时加一个 header（store 名、字符占用率），**header 不写回文件**。所以：

- 文件里写 `## 环境`、`## 偏好` 不会变成“小节”；它只是某条 entry 的一部分，照样占字符预算，`patch/remove` 也按整条 entry 操作。
- 条目内部可以多行；多行不会改变 entry 身份。
- 没有预设字段、没有 frontmatter、没有固定分类；只有“一条条声明式事实”。
- 官方文档给的是“好 entry / 坏 entry”示例，不是 section 模板。

如果要在我们自己的实现里让内容更有可读性，建议用**条目前缀**而不是 Markdown 标题：

```text
[env] Project ~/code/agent is Node ESM; run `pnpm test` and `pnpm graph` before delivery.
[env] This machine runs Ubuntu; bash is persistent; Docker is unavailable.
[convention] Architecture boundaries live in arch.md; do not add cross-layer imports.
[lesson] The reference Hermes clone is under reference/hermes-agent and is gitignored.
```

这只是**人类可读的自定义约定**，不是 Hermes 原生结构；解析器仍然把它当一条 entry。前缀会占字符，所以只在条目确实需要分类时使用，不要为了“好看”给每条都加标签。

## 2 怎么写：先分清两个 target

Hermes 没有两套完全独立的提示词。它共用一段 memory guidance，加一段 review routing block，靠 `target` 分流。核心规则是：

- **`USER.md`（target=`user`）**：关于“人”的稳定事实。
  - 姓名、角色、时区；
  - 语言/格式偏好（简洁还是详细、先代码还是先解释）；
  - 明确说过的喜恶、沟通习惯、工作流习惯；
  - 对 Agent 行为方式的期待。
- **`MEMORY.md`（target=`memory`）**：关于“环境和做事方式”的稳定事实。
  - 操作系统、工具版本、路径、端口、服务；
  - 项目约定、目录结构、构建/测试命令；
  - 工具怪癖与 workaround；
  - 用户纠正过的、适用于这类任务的规则；
  - 已经完成、值得留档的工作（但要极简，不能写成日记）。
- **一条事实只进一个库。** 写进两个库会同时挤占两份预算，而且下个会话可能从错误的库读。Hermes 的 routing prompt 明确写 “One fact goes to ONE store, never both”。

> 注意：`USER.md` 不是 persona / `SOUL.md`。`SOUL.md` 是用户手写的人格与口吻，`USER.md` 是 Agent 维护的用户画像；两者不会互相喂内容。我们的 `agent/config.json` 里的 `persona` 对应前者，不应拿来承载用户偏好。

### 可直接照用的示例

`USER.md`：

```text
User is a backend engineer working mainly in TypeScript/Node; prefers pnpm over npm.
User prefers concise Chinese answers: code/diff first, explanation second.
User is in UTC+8 and often works late; don't ask them to repeat context already in the repo.
User dislikes being asked for confirmation on reversible local edits.
```

`MEMORY.md`：

```text
Project ~/code/agent is Node ESM; layers and boundaries are defined in arch.md. Verify with `pnpm test` and `pnpm graph` before delivery.
This machine runs Ubuntu; bash is persistent across calls; Docker is not available.
The Hermes reference clone lives at reference/hermes-agent and is gitignored; do not commit it.
```

反例：

```text
# 太虚，无法指导行为
User likes good code.

# 命令式，会在未来会话被当成指令，可能压过用户当下的要求
Always answer in Chinese.

# 一次性上下文，不该进长期记忆
User asked about React hooks in this session.

# 原始数据/大段日志，应该留在会话或文件里
<200 行构建日志>
```

Hermes 特别强调：**写成陈述句，不要写成对自己的命令**。“User prefers concise responses” ✓；“Always respond concisely” ✗。后者会在未来会话里被重新读成一条指令。

### 什么该存，什么不该存

| 存 | 不存 |
|---|---|
| 用户明确说过的长期偏好 | 一次性请求、临时任务进度 |
| 稳定的环境事实（OS、工具、路径、端口） | 一周内就会变的临时路径/状态 |
| 项目级约定、测试/构建命令 | 代码块、日志、数据表等原始大块内容 |
| 用户纠正过、可复用的规则 | 已经写在 `AGENTS.md` / skills 里的内容 |
| 已完成、值得留档的迁移/变更 | “用户问过 Python”这类无信息量的流水 |

### 和 skill 的分工

这是 Hermes 记忆设计里最容易做错的一点：

- **跨任务、每会话都成立** → memory。
- **做某类任务才需要的流程、坑、用户对该类工作的偏好** → skill。
- **一次性历史细节** → `session_search`，不占 memory。

`build_memory_guidance` 的原话就是：“Skills come first: when you learn something while doing a task — a procedure, a pitfall, and the user's preferences and corrections for that kind of work — record it in the skill you used or built for the task... Memory is the narrow exception for facts that apply to EVERY session regardless of task.”

## 3 真实提示词

### 3.1 Memory guidance（注入 system prompt 的行为约束）

来源：`agent/prompt_builder.py::build_memory_guidance`。当 `memory` 工具在 `valid_tool_names` 里时才注入；如果两个 store 都关闭，就不注入。

核心原文（节选，保留关键约束）：

```text
You have persistent memory, carried across sessions and loaded into each new
session's context; the memory tool's schema defines what belongs there.

Skills come first: when you learn something while doing a task — a procedure,
a pitfall, and the user's preferences and corrections for that kind of work —
record it in the skill you used or built for the task (skill_manage), where it
loads only when relevant.

Memory is the narrow exception for facts that apply to EVERY session regardless
of task (who the user is, environment facts, standing conventions with no task
home); it has a hard character budget, so when it fills, replace or consolidate
stale entries rather than skipping the save.

Write entries as declarative facts, not instructions to yourself:
'User prefers concise responses' ✓ — 'Always respond concisely' ✗
(imperative phrasing gets re-read as a directive in later sessions and can
override the user's current request). A fact stale within a week belongs in
session history; procedures and workflows belong in skills.
```

### 3.2 后台复盘的 routing block + review prompt

来源：`agent/background_review.py::_MEMORY_ROUTING_BLOCK`、`_MEMORY_REVIEW_PROMPT`。这是后台 fork 用来决定“这条事实写不写、写哪个库”的提示词。

```text
Review the conversation above and consider saving to memory if appropriate.

Memory has TWO distinct stores — pick the right one for each fact:
  • USER.md (memory tool, target='user'): who the user is — persona, preferences,
    communication and work style, personal details they revealed, and expectations
    about how you should behave.
  • MEMORY.md (memory tool, target='memory'): facts about the ENVIRONMENT you
    operate in — tool quirks, project conventions, config gotchas, paths and
    endpoints that matter.

One fact goes to ONE store, never both — writing it to both bloats both files
until they hit their size limits and crowds out the facts that matter; misrouting
it puts it where the next session won't look.

Save only facts GROUNDED in this conversation — a user message or tool result
you can point to. Never infer the user's traits, skill level, role, mood or
preferences from topic, tone or tools used, and never turn a one-off request
into a standing preference (in either store) unless the user marked it general
('always', 'from now on', 'remember') or stated a standing like/dislike
('I hate X', 'stop doing Y'). If unsure, leave it out — a wrong fact misleads
every future session.

If something stands out, save it once, in the right store, using the memory tool
with the matching target. If nothing is worth saving, just say 'Nothing to save.'
and stop.
```

这段提示词的重点不是“多写”，而是**少写、写准**：必须有对话证据；不能从语气/话题推测用户画像；不能把一次性请求升级成长期偏好。

### 3.3 `memory` 工具 schema 的约束

来源：`tools/memory_tool.py::MEMORY_SCHEMA`。关键不是参数名，而是它怎么写“什么时候用”：

```text
Save durable facts to persistent memory that survive across sessions. Memory is
injected into every future turn, so keep entries compact and high-signal.

HOW: make ALL your changes to one target in ONE call via an 'operations' array
(each item: {action, content?, old_text?}). The batch applies atomically and the
char limit is checked only on the FINAL result — so a single call can
remove/patch stale entries to free room AND add new ones, even when an add alone
would overflow.

WHEN: only for facts that apply to EVERY session regardless of task: who the
user is, stable environment facts, standing conventions with no task home.
Anything learned while doing a task ... belongs in the task's skill via
skill_manage, where it loads only when relevant; memory is injected into every
turn and must stay small.

TARGETS: 'user' = who the user is (name, role, preferences, style).
'memory' = your notes (environment, conventions, tool quirks, lessons).

SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task
progress, completed-work logs, temporary TODO state (use session_search for
those). Reusable procedures belong in a skill, not memory.
```

## 4 写入协议

Hermes 的 `memory` 工具只有三种 action，**没有 `read`**：记忆已经在 system prompt 里，模型不需要读接口。

- `add`：新增一条 entry，`content` 必填。
- `patch`：替换 entry 内的一段，`old_text` 是原 span，`content` 是新 span；其余内容保留。
- `remove`：删掉整条 entry，`old_text` 用短唯一子串匹配；匹配多条会报错。
- `operations`：一次调用里对**同一个 target**做批量 add/patch/remove，原子应用；字符上限只看 batch 的最终结果。这正是“内存满了”时的正确姿势：一个 batch 里删/缩旧条目再加新条目。
- 不提供 `replace`：Hermes 发现模型会把 `replace` 当 find-and-swap 用，结果把多事实 entry 的其他内容一起覆盖，所以直接移除，只留 `patch`。
- 精确重复会被拒绝；`patch`/`remove` 的 `old_text` 匹配不到时，会返回最相近的条目供模型修正。
- 写入前会做 threat scan；命中 prompt injection、凭据外泄、隐藏 Unicode 等模式直接拒绝。

## 5 注入与冻结

会话开始时，Hermes 从磁盘加载两个文件，渲染成 system prompt 的一个块：

```text
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
User's project is a Rust web service at ~/code/myapi using Axum + SQLx
§
This machine runs Ubuntu 22.04, has Docker and Podman installed
§
User prefers concise responses, dislikes verbose explanations
```

关键点：

- 头部显示 store 名、使用率和字符数，模型能看到自己还剩多少预算。
- 条目用 `§` 分隔，条目内部可多行。
- **快照在会话首轮冻结**：会话中 `add/patch/remove` 会立刻落盘，但不会改动已经构建好的 system prompt；下个会话才看到新内容。工具返回里会显示 live 状态，所以当前会话不会“丢”信息，只是 prompt 前缀不变。
- 这就是 Hermes 让 memory 和 prompt cache 共存的方式：**读写分离，快照只读**。

## 6 后台复盘：写记忆不靠主对话“顺便”

来源：`agent/background_review.py`、`agent/review_signals.py`、`agent/turn_context.py`。

- 触发按计数器，不是每轮：
  - `memory.nudge_interval` 默认 10：每约 10 个用户回合触发一次 memory review；
  - `skills.creation_nudge_interval` 默认 10：每约 10 次工具迭代触发一次 skill review。
- 到期后 fork 一个受限 agent，重放当前对话快照，问“有没有值得保存的 memory/skill”。
- fork 继承父级的 provider/model/凭据和 cached system prompt，尽量命中同一 prefix cache；但写入走 dispatch-side tool whitelist，只允许 memory/skill 管理工具，不能用通用文件写工具乱改。
- `skip_memory=True` 用于外部 provider 隔离；内置 `MEMORY.md`/`USER.md` 状态会重新绑定到 fork。
- 写完直接落盘，不碰主会话，也不改主会话的 prompt cache。
- `write_approval: true` 时，后台写入会 stage 成 pending，必须 `/memory pending` 后人工 `/memory approve`；`patch/remove` 会 pin 住被审阅的那一条 entry，审批时如果 entry 已经变了就拒绝，避免“批准的是旧内容、应用的是新内容”。
- cron 和 delegated child 默认不触发后台复盘；避免无人值守任务把临时上下文写进长期记忆。

## 7 安全与边界

记忆会进入 system prompt，所以它等于一个**持久化的 prompt injection 面**。Hermes 的防线：

- 写入前 strict threat scan，拒绝注入/外泄模式与隐藏 Unicode；
- 原子写 + 备份 + 文件锁；文件被外部改成非 `§` 结构时拒绝写入，避免“按空文件重写”丢数据；
- 一个 Hermes home 只允许一个 agent 进程写，避免两个 writer 互相叠加出谁都没写过的状态；
- 用户画像和记忆按 profile 隔离，不跨 profile 回退；
- 外发 provider 前做 egress redaction，密钥/URL 凭据不落外部记忆；
- 字符上限硬拒绝，不静默截断；重复 entry 拒绝。

## 8 对我们项目的最小实现

我们的约束：主 Agent 默认 Minimal 双工具（`bash` + `str_replace_editor`），不能为了记忆再加第三个工具。可行方案是把“读”和“写”分开：

1. **存储**：`user/memory/MEMORY.md` / `USER.md`，`§` 分隔；默认上限先照 2,200 / 1,375。不要复用 `core/memory/`（那里是运行时 RequestSpec/StepState 等数据结构），新建 `lib/memory-store` 或 `core/user-memory`。
2. **读**：`core/system-prompt.js` 增加 memory section，在首轮 `assembleSystemPrompt` 时读快照；持久会话沿用 `session.prompt` 冻结。主 Agent 不需要 `memory` 工具也能“看到”记忆。
3. **写**：新增 `tools/memory`，但 `defaultVisible: false`；只允许后台 review fork 用显式 `toolNames: ["memory"]` 调用。主 Agent 的 Minimal 工具面保持两项。显式“记住这个”建议走 UI/RPC 的 memory 写入，或者由 review fork 立刻处理，不要给主 Agent 加第三个工具。
4. **复盘**：在 `turn-end` 后做非阻塞 review，计数 10 个用户回合；只允许 memory 工具；跳过 cron/子代理/被中断的 turn；先只处理“有直接证据”的稳定事实，其余进 proposal。
5. **审批**：第一版建议后台写入默认 `pending`，UI 提供 approve/reject；用户当场明确要求“记住”的写入可以直接落盘。这样既有 Hermes 的自动学习，又不会让后台猜测悄悄改用户画像。
6. **检索**：先不做 FTS5/向量；等用户开始问“上次说过什么”，再接 `session_search` 或现有 SQLite FTS。

## 9 验收清单

- 首轮注入后，连续两轮 `system` 字节不变；memory 写入不改变当前 prompt。
- `MEMORY.md` / `USER.md` 超限时返回错误 + 当前条目，batch 删/缩后可成功。
- `add` 的重复 entry 被拒绝；`patch` 匹配多条时要求更具体的 `old_text`。
- 含注入模式/隐藏 Unicode 的内容被拒绝；外部改坏文件时拒绝覆盖。
- 后台 review 只在 10 回合触发；cron/子代理不触发；未批准 proposal 不进入正式文件。
- 主 Agent 工具清单仍严格等于 `bash, str_replace_editor`。

## 10 源码索引

| 主题 | 文件 |
|---|---|
| memory 工具、schema、写入 gate | `reference/hermes-agent/tools/memory_tool.py` |
| 文件存储、`§`、字符上限、原子写/备份/drift | `reference/hermes-agent/tools/memory_tool_store.py` |
| memory guidance 提示词 | `reference/hermes-agent/agent/prompt_builder.py` |
| system prompt 注入与 volatile 层 | `reference/hermes-agent/agent/system_prompt.py` |
| 后台复盘、routing block、review prompt | `reference/hermes-agent/agent/background_review.py` |
| 触发计数 | `reference/hermes-agent/agent/turn_context.py`、`agent/review_signals.py` |
| 默认间隔与配置 | `reference/hermes-agent/agent/agent_init.py` |
| provider seam（内置 + 一个外部） | `reference/hermes-agent/agent/memory_provider.py`、`agent/memory_manager.py` |
| 官方用户文档（格式/审批/容量） | `reference/hermes-agent/website/docs/user-guide/features/memory.md` |
