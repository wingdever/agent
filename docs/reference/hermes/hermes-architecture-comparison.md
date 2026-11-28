# Hermes Agent 与本项目架构对比

> 对比基线：Hermes `main` @ `337903eeffd696cf73936a3a00af08b43feb2028`，浅克隆在 `reference/hermes-agent`（被 `.gitignore` 的 `/reference/` 忽略）；本项目 HEAD `7e362a3`。
>
> 方法：只读源码，不做业务代码改动。本文的结论以实际文件为准，不沿用 `docs/reference/hermes.md` 的产品介绍；该笔记负责“Hermes 有哪些能力”，本文负责“两边架构差在哪、我们该学什么”。

## 0 结论先行

Hermes 不是“更大的我们”。它是面向多入口、多平台、带学习闭环的个人助理产品；我们是本地优先、分层严格、以节点图编排为核心的 Agent 工作台。直接照搬会把我们的边界优势换成维护负担。

真正值得学的是三件事：

1. **把工具面收窄，并按会话冻结。** 我们现在默认可见 59 个工具，仅 schema 就约 47k 字符（按 4 字符/token 粗估约 11.8k tokens），而且工具集每轮重算。Hermes 用 toolset 分层，并把工具面固定到会话边界。
2. **把出站投递做成持久义务账本。** 我们的入站队列、ACK、死信已经不错，但“平台已发送成功、本地还没 ACK/落库时进程崩溃”仍会重放成重复消息。Hermes 的 delivery ledger 正是从这类事故反推出来的。
3. **补最小可用的长期记忆与技能生命周期。** 我们已有技能加载，但没有用户长期记忆、没有轮后反思、没有技能 CRUD。Hermes 的 MEMORY.md/USER.md + 受限后台复盘 + curator 是目前最完整的参照；我们应做“提议→评审→应用”，不要默认自动写。

我们的相对优势也要保住：可执行的 12 条分层规则、节点图编排、按实例隔离的 channel 运行时、团队 DAG 的 revision CAS 与写作用域提示，都是 Hermes 那种 Python 单体 + 大量边缘插件结构里更难得的部分。

## 1 两套架构速写

### Hermes：一个 agent core，能力在边缘

```text
CLI / TUI / Desktop / Web / ACP / Gateway(25+ 平台)
                    │
              AIAgent facade (run_agent.py)
                    │
        conversation_loop.py（同步 turn 循环）
                    │
  turn_*.py（preflight / api_call / tool_round / compaction / finalizer）
        │                 │                  │
   toolsets + registry   memory/skills     gateway delivery
        │                 │                  │
      plugins          curator/background   profile scope + ledger
```

关键事实：

- 根 `AGENTS.md` 把两条不变量写成几乎所有设计决策的透镜：**per-conversation prompt caching is sacred**；**core is a narrow waist, capability lives at the edges**。
- `agent/system_prompt.py` 的 docstring 明确：system prompt **每会话构建一次，跨轮复用，只有 context compression 触发重建**；stable / context / volatile 三层都冻结在会话开始时。
- `agent/conversation_loop.py` 是同步循环，默认 `max_iterations=500`，每轮阶段拆成 `turn_*.py`，工具分发在 `model_tools.py::handle_function_call()`。
- `gateway/` 是一个进程接多平台、多 profile：`RoutingIdentity` 在 key 派生之前解析“哪个 bot 收到 / 谁有权准入 / 在哪运行”，`transport_profile` 与 `runtime_profile` 分离，token lock、secret scope、delivery ledger 都在这一层。
- `tools/` 用 `registry.register()` 自动发现，`toolsets.py` 决定暴露面；核心工具的门槛很高，新能力优先走 CLI + skill、service-gated tool 或 plugin。
- `cron/` 有独立的作业存储、occurrence ledger、catch-up 窗口、per-home tick lock；`agent/background_review.py` / `agent/curator.py` 负责记忆与技能的写入、维护。

### 本项目：分层优先，节点图执行

```text
UI / ACP / A2A / channels（embedded | service）
                    │
        AgentRuntime + AgentRegistry（会话/轮次/inbox/gates）
                    │
          core/loops/node-graph（turn 节点图）
                    │
 context / model-request / storage / tools / skills / compaction
```

关键事实：

- `arch.md` 定义了 `lib / core / tools / channels / proxies / providers / ui / launcher` 的单向依赖，规则由 `scripts/graph/arch-rules.json` 执行；当前 `pnpm graph` 为 316 nodes / 457 edges / 12 rules clean。
- `core/system-prompt.js` 负责 section 排序与变量插值；持久会话的 system prompt 在首轮写入 `session.prompt`，后续轮次读回（`core/loops/nodes/assemble-system/run.js`、`core/loops/linear.js`）。
- `core/loops/nodes/turn-start/run.js` 每轮重新 `selectForExecutor` 并生成 `toolDefs`；工具来自 profile 的 `tools.json` 或主档可见集。
- `channels/` 每个实例一个进程/锁/历史 SQLite；`lib/channel-service/runtime.js` 统一 embedded 与 service 两种模式，core 通过 SSE 拉取、通过 `/proactive` 回写。
- `core/compaction.js` / `core/compaction-runner.js` 是 DSH 移植：自动阈值 0.8、保留约 16%、先 prune 旧 tool result、再让模型写 checkpoint。
- `core/memory/` 是 agent runtime 数据结构（RequestSpec / StepState 等），不是用户长期记忆；仓库里没有 `MEMORY.md` / `USER.md`。
- `core/skills/` 与 `tools/skill/` 只做发现、加载和渲染，没有 create/patch/delete 的模型工具。
- `core/schedule/` 是“到点唤醒一个已有/新会话”的提醒，不是 Hermes 那种带脚本、技能、跨平台投递的 cron 作业。
- `core/team/` 已有持久 DAG、revision CAS、`writeScopes` 重叠提示，但没有 lease/heartbeat/stale reclaim。

## 2 关键差异矩阵

| 维度 | Hermes | 本项目 | 判断 |
|---|---|---|---|
| 运行引擎 | 同步 turn 循环，阶段拆成 `turn_*.py`，默认 500 次迭代上限 | 节点图，`AgentRegistry` + phase/inbox/gates，未设步数上限 | 我们更灵活、并发隔离更清楚；Hermes 的阶段拆分更容易做单点不变量测试。不要换引擎，补预算与契约测试。 |
| Prompt 缓存 | 会话级冻结，只有 compression 重建；技能 slash、AGENTS.md hint 都走 user message / tool result | 持久会话的 system prompt 首轮落库后复用；但 `toolDefs` 每轮重算，profile 变更可能让 prompt 与工具面不一致 | 大方向已经对齐；残余风险在“工具面未冻结”和注释/文档漂移。 |
| 工具面 | toolsets 分层，`check_fn` 按 profile TTL 缓存，新能力优先 plugin/skill | 59 个默认可见工具，仅 schema 约 11.8k tokens；主档空 tools 等于“默认全可见” | 这是我们最明确的成本/选择性问题。先做 toolset 与快照，不需要 plugin 体系。 |
| 上下文压缩 | 两层：gateway 85% 会话卫生 + agent 50%；确定性 prune 后走 auxiliary compression model；overflow 有 cooldown/fallback | 0.8 阈值、保留 16%、DSH checkpoint；无 auxiliary 路由、无 overflow cooldown | 我们的 checkpoint 质量不差，但触发偏晚、缺少失败退路和压缩后 runtime context 刷新。 |
| 长期记忆 | `MEMORY.md` / `USER.md`、字符上限、冻结快照、轮后 review、FTS5 session search | 无用户长期记忆；`core/memory` 只是运行时结构 | 最大产品能力缺口。先做最小双文件 + 提议队列，不要一上来做 Honcho/向量库。 |
| 技能生命周期 | 自动创建、`skill_manage` 全 CRUD、使用中 patch、curator stale/archive、provenance/read-check | 只读加载与渲染 | 需要补管理面，但应加“提议→评审→应用”的门，避免自动写脏技能库。 |
| Channel / Gateway | 单进程多平台、多 profile；identity-first、transport/runtime 分离、secret fail closed | 每实例独立进程/锁/DB；embedded 与 service 双模式；core-pull | 小规模下我们的隔离更简单、更安全。只有在多实例运维或跨平台身份路由成为真问题时，才引入 gateway 聚合层。 |
| 出站投递 | 持久 delivery ledger，区分 pending / attempting / delivered / failed / abandoned；崩溃后带可见标记重发 | 入站有 history + dedupe + ACK + 死信；出站是“发送成功后 appendOutbound”，没有发送前义务记录 | 明确的可靠性缺口。优先补 ledger，不要只加 retry。 |
| 多 profile 隔离 | `RoutingIdentity`、`transport_profile` 持久化、token lock、secret scope | OS 进程 + 每实例 DB + 文件锁；没有进程内多 profile | 现在不需要 Hermes 那套复杂度；若未来一个进程接多个 bot，再按 identity-first 复制。 |
| 委派 / 团队 | subagent、background completion queue、kanban claim/heartbeat/stale reclaim/failure limit | subagent 一次性 fire-and-forget；team DAG 有 owner/revision，但无 lease/heartbeat | 我们的 DAG 更适合“有界任务板”；补 lease 与失败上限即可，不必上完整 kanban。 |
| 定时任务 | cron job + occurrence ledger + catch-up + timezone + 跨平台投递；headless 拒绝 spawn | `ScheduleService` 只承诺“到点唤醒会话”，没有 occurrence ledger 和 channel 投递目标 | 若产品要“主动发消息/日报”，这是必须补的；否则保持提醒语义即可。 |
| 扩展机制 | plugin ABC + hooks + `ctx.register_tool` + host 隔离 + catalog | 静态 `tools/<name>/registry.json` 插槽 + skills；无第三方 plugin API | 我们的静态边界更可控。除非要接第三方工具生态，否则不建议复制 plugin host。 |
| 测试与文档 | prompt surface snapshot、behavior-contract、临时 `HERMES_HOME` 的 E2E | 643 个测试、架构图规则、channel 真机验证；缺 prompt/tool 快照与崩溃恢复 E2E | 我们的基础不弱；补“字节稳定”和“崩溃点”两类测试，比堆数量更有价值。 |

## 3 建议的改进路线

### P0-1 工具面收窄并按会话冻结

**为什么**

当前 59 个 `defaultVisible` 工具，registry JSON 的 name/description/parameters 合计 47,143 字符，约 11.8k tokens；这还不含 system prompt 里的 tool guidance。Hermes 的根文档明确说“每个模型工具都会在每次 API call 发送”，所以它把新能力推到 CLI + skill / plugin，并用 toolset 控制暴露面。我们每次调用都背着全套 schema，既贵，也增加模型误选工具的概率。

**怎么做**

1. 复用现有 `group` / `package` 元数据，定义 `toolsets`（例如 `core`、`fs`、`shell`、`web`、`browser`、`terminal`、`job`、`schedule`、`team`、`channel`、`goal`、`mcp`）。profile 选 toolset，不再只选平铺的 59 个名字。
2. 默认主档收窄到“日常核心”（读写文件、shell、web、skill、interaction、deliverable）；浏览器、终端、job、schedule、team、channel 等按 profile 显式启用。
3. 在会话首轮把 `selected`、`toolDefs`、以及对应 prompt section 一起快照，写入 session；后续轮次只读快照。profile 或 activity 变化在下一个会话生效；需要立刻生效时走显式 `/new` 或等价的重置入口。
4. 让 system prompt 的 tool guidance 也只从同一份快照生成。现在首轮 system prompt 用的是首轮 `request.selected`，而后续 `toolDefs` 每轮重算；一旦 profile 变化，两者会漂移。

**验收**

- 同一持久会话连续两轮：`system` 与 `toolDefs` 字节一致（可序列化后比较 hash）。
- 切换 profile 不改变当前会话的工具面；新会话才生效。
- 工具 schema token 数相对当前基线下降 ≥ 50%，且核心任务回归测试通过。
- `pnpm graph` 仍为 12 rules clean；新增测试不依赖精确工具数量，只验证“选中的集合与快照一致”。

### P0-2 出站投递义务账本

**为什么**

`channels/callback.js` 的顺序是：`channel.project()` 发送 → `onDeliver()` 写 outbound history → `onAck()`。如果进程在发送成功之后、ACK/落库之前崩溃，入站事件仍是 pending，重放就会再发一次。现有 `sent=true` 只能处理“ACK 失败但进程还活着”的情况，处理不了崩溃窗口。

Hermes 的 `gateway/delivery_ledger.py` 把这个问题拆成五个状态：

- `pending`：还没开始发，崩溃后可以 plain redeliver；
- `attempting`：已经进入发送 await，平台**可能**收到了，重启后重发要带可见的 “Recovered reply” 标记；
- `delivered`：只有平台确认成功才写，之后只负责 ACK/清理；
- `failed` / `abandoned`：确定性拒绝或超过尝试上限，进入死信而不是静默丢失。

**怎么做**

1. 在 channel service 的同一个 SQLite 里加 `delivery_obligations`（或 outbox 表）：`delivery_id`、`event_id`、`instance_id`、`conversation_key`、`payload_hash`、`state`、`attempts`、`owner_pid`、`owner_started_at`、`updated_at`。
2. `/proactive` 收到发送请求时先写 `pending`；调用 `channel.project()` 前写 `attempting`；平台返回成功后写 `delivered`，再 ACK 入站事件。
3. 启动时扫描 `attempting`：若 owner 进程已死，重发时在文本前加可见标记，或使用平台幂等键；没有幂等能力时明确接受 at-least-once，不假装 exactly-once。
4. 明确失败分类：平台明确拒绝进 `failed`；超过尝试上限或过期进 `abandoned`；ledger 写失败不能阻塞发送，但必须记日志/告警。

**验收**

- 在“发送成功、ACK 前”注入 `kill -9`，重启后：用户最多看到一条带恢复标记的重复消息，不会静默丢失，也不会无限重发。
- “发送前崩溃”重发不带标记；“发送后崩溃”重发带标记。
- `delivery_id` 可被 core 的 `sendToChannel` 回传，ACK 只针对已 `delivered` 的义务。
- 新增 crash-point E2E；现有的 `scripts/verify-channel-runtime.js` 继续 PASS。

### P0-3 最小长期记忆与技能生命周期

**为什么**

Hermes 的产品差异很大一部分来自“会记住、会改进”。我们目前只有技能加载，没有用户画像、环境事实、轮后反思，也没有技能 CRUD。但 Hermes 的完整实现（后台 fork、字符上限、curator、provenance、read-check）成本很高，直接全量复制会拖垮当前节奏。

**建议的 MVP**

1. **双文件**：`user/memory/MEMORY.md`（环境事实、约定、教训）与 `user/memory/USER.md`（用户画像、偏好），字符上限先按 2200 / 1375 执行，超限拒绝写入并提示先删旧条目。
2. **冻结快照**：会话首轮把两份文件注入 system prompt 的 volatile 段并随 `session.prompt` 冻结；本会话内的写入只更新文件与工具返回的 live 状态，下个会话才进 prompt。这样不破坏 prefix cache，也和 Hermes 的“写入立即落盘、下一会话生效”一致。
3. **轮后复盘**：用户回合数或工具迭代数到阈值（例如各 10）时，在 turn 收尾只设 flag；由一次受限的辅助模型调用生成“候选记忆/候选技能”，不直接改主会话。跳过 cron、子代理、被中断的 turn。
4. **提议队列**：候选写入 `user/memory/proposals/` 或 pending 表，带来源 turn、证据、目标文件、diff；默认需要人工批准才 apply。技能同理，先 `skill_manage(create/patch)` 生成 proposal，不直接写仓库技能。
5. **技能管理的最小面**：`skill_manage` 只支持 `create` / `patch` / `delete` / `write_file`，加 provenance 与“本轮读过才能改”的 read-check；暂不做 curator 自动归档，先做“标记 stale”报告。

**验收**

- 记忆跨会话可见；同一会话内 system prompt 字节不变。
- 未批准 proposal 不落正式文件；批准后写入是原子写，失败不破坏旧文件。
- 字符上限、路径校验、read-check 都有测试；cron/子代理不触发复盘。
- 技能 proposal 不能改非本会话创建/未读过的技能。

### P1-1 压缩策略补齐

当前 0.8 阈值偏晚，且没有 auxiliary 路由与 overflow 失败退路。建议：

- 自动阈值改为可配置，默认先试 0.6–0.65；按模型 context window 覆盖。
- 保留确定性 prune 前置；summary 走独立的便宜模型路由，不占用主模型。
- 连续 overflow 后进入 cooldown，并提供确定性 fallback summary；记录 tokens before/after 与 cache read。
- **压缩时重建 runtime context 尾段**（时间、cwd、model）。我们目前压缩仍用旧 system prompt；Hermes 把 compression 视为唯一允许的 prompt 重建点，正好用来刷新会过期的环境信息。

### P1-2 给 turn 加预算上限

Hermes 默认 `max_iterations=500` 且有 iteration budget / 一次 grace call；我们注释明确“不设步数上限，是否继续由模型决定”。这在长任务里可能变成成本失控。建议加可配置的 `maxSteps` 与 token budget，默认给一个务实上限（例如 200 步），触顶时走“总结 + 请求确认”而不是硬中断；不要退回固定 5 步那种拍脑袋限制。

### P1-3 有需要再做 channel gateway 聚合

我们当前“一个实例一个进程/锁/DB”在单机少实例时更安全，别为了架构好看先把所有 adapter 塞进一个进程。出现以下信号再做聚合：

- 3 个以上常驻 channel 实例，进程/端口/锁的运维成本明显；
- 需要跨平台统一身份、统一投递账本、统一限流；
- 需要“同一个 bot 收到、另一个 profile 执行”的路由。

届时按 Hermes 的顺序复制：先 `RoutingIdentity`（identity 先于 key），再 transport/runtime profile 分离，再 token lock 与 secret fail-closed，最后才是单进程多 adapter。不要用 `process.env` 当共享默认。

### P1-4 定时任务补“投递目标 + occurrence ledger”

如果产品要“到点主动发到某个群/某个人”，`ScheduleService` 需要：

- target 增加 `{kind:"channel", instanceId, conversationKey}`；
- 每次 occurrence 先推进 `next_at` 再 dispatch，写 `pending_slot`，崩溃后按 ledger 恢复；
- catch-up 窗口与 grace，`0` 表示绝不补跑；
- 无 gateway 时 headless tick 明确拒绝，不偷偷 spawn。

如果只是“提醒当前会话”，保持现状即可，不要过度设计。

### P1-5 团队任务补 lease / heartbeat

`core/team/` 已有 DAG 与 revision CAS，缺的是“进程死了任务怎么办”。补：

- `lease_owner` / `lease_until` / `heartbeat_at`；
- claim 用 CAS，stale lease 可回收；
- 连续失败上限，超限自动 block，避免 spin；
- 用 `(pid, started_at)` 识别 owner，不用裸 PID。

这比复制整套 kanban 更贴合我们现有的 team 语义。

### P2 测试、文档与小边界

- **prompt/tool surface snapshot**：把某个 profile 的 system prompt 与 toolDefs 渲染成固定 fixture；改 prompt 或工具必须更新快照。
- **字节稳定测试**：同会话两轮 system/toolDefs hash 相同；压缩后只允许一次预期变化。
- **崩溃 E2E**：channel service 在发送前/发送后/ACK 前三个点被杀，重启行为符合 ledger 契约。
- **behavior-contract**：断言“工具被注册、事件带正确字段、快照一致”，不要断言工具总数或源码字符串。
- **修文档漂移**：`core/system-prompt.js` 顶部还写“built once per chat() call”，实际持久会话是首轮落库、跨轮复用；这类注释会误导后续改动。
- **plugin API**：只有确定要接第三方工具/提供商时再做最小 `registerTool` + hooks；不要现在复制 Hermes 的 plugin host / catalog。
- **provider 方言**：当前 `core/model-request.js` 只发 Chat Completions。若要接 Anthropic Messages 或 Responses API，先抽 provider adapter 接口，不要把所有 OAuth/credential pool 复杂度一起搬进来。

## 4 不建议照搬的部分

| Hermes 做法 | 为什么不建议直接搬 |
|---|---|
| 25+ 平台、单 gateway 进程、多 profile | 当前规模用每实例进程隔离更简单；聚合会引入 identity、token lock、secret scope、delivery 路由一整套复杂度。 |
| plugin host / catalog / 多 ABC 隔离 | 我们没有第三方插件生态；静态 `tools/` 插槽 + 能力标签已够用，先补 toolset 即可。 |
| 60 参数 `AIAgent` + 大量 mixin + 同步循环 | 我们的节点图与显式状态归属更易读；要学的是阶段不变量，不是文件组织。 |
| 默认自动写记忆/技能 | 我们是开发者工作台，技能库和仓库文档需要可审计；“提议→评审→应用”比自动写更合适。 |
| 50% 自动压缩作为默认 | 对成本敏感的部署可能过于激进；先做成可配置，用真实 token 曲线校准。 |
| 完整 kanban 多租户看板 | 我们的 team DAG 已覆盖有界协作；只补 lease/heartbeat，不引入 board/tenant/dispatcher 全套。 |
| `_last_resolved_tool_names` 这类进程级全局 | Hermes 自己也在子代理里保存/恢复它；我们应继续用显式上下文，不新增进程全局。 |

## 5 建议实施顺序

1. **工具面 toolset + 会话快照 + prompt/tool 字节稳定测试**：先拿到可量化的 token 下降，再谈其他优化。
2. **channel 出站 ledger + 三个崩溃点 E2E**：这是可靠性问题，优先级高于新功能。
3. **记忆/技能 proposal MVP**：先双文件 + 受限复盘 + 人工批准，再考虑 curator。
4. **压缩阈值/aux 路由/overflow 退路 + turn 预算**：用真实会话数据调，不拍脑袋。
5. **schedule 投递目标 / team lease**：按产品需求排；没有主动投递需求就不做。
6. **gateway 聚合**：只在多实例运维或跨平台身份路由成为实际问题时启动。

## 6 验证基线

本次对比期间未改业务代码，仅新增本文档。当前工作区基线：

- `pnpm test`：643 tests / 640 pass / 3 skipped / 0 fail。
- `pnpm graph`：316 nodes / 457 edges / 12 rules clean。
- `node scripts/verify-channel-runtime.js`：PASS（真实 HTTP/SSE 上完成 message + ACK）。
- `reference/hermes-agent` 被 `/reference/` 忽略，不进入本项目版本库。

## 7 证据索引

| 主题 | Hermes 源码 | 本项目对应 |
|---|---|---|
| 两条核心不变量 | `reference/hermes-agent/AGENTS.md` | `arch.md` |
| 同步 turn 循环 | `agent/AGENTS.md`、`agent/conversation_loop.py` | `core/loops/node-graph.js`、`core/loops/nodes/*` |
| system prompt 冻结 | `agent/system_prompt.py` | `core/system-prompt.js`、`core/loops/nodes/assemble-system/run.js` |
| 工具面 / toolsets | `tools/AGENTS.md`、`toolsets.py`、`tools/registry.py` | `core/tools/registry.js`、`tools/*/registry.json` |
| 上下文压缩 | `agent/conversation_compression.py`、`turn_context_compaction.py` | `core/compaction.js`、`core/compaction-runner.js` |
| 记忆/技能闭环 | `agent/background_review.py`、`agent/review_signals.py`、`agent/curator.py` | `core/skills/`、`tools/skill/`；详见 `docs/reference/hermes.md` |
| gateway 身份与投递 | `gateway/AGENTS.md`、`gateway/session_identity.py`、`gateway/delivery_ledger.py` | `channels/`、`lib/channel-service/`、`lib/channel-history/` |
| 定时任务 | `cron/AGENTS.md`、`cron/scheduler.py`、`cron/occurrences.py` | `core/schedule/` |
| 团队/委派 | `tools/AGENTS.md`、`agent/delegation_context.py`、`kanban` 相关 | `core/subagent-runtime.js`、`core/team/` |
