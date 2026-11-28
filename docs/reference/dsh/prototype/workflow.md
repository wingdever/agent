# workflow

以 DSH 线上实现为准的 workflow 参照原型：一组「模型写脚本、脚本派生 subagent、脚本返回值作为工具结果」的编排能力。模型侧的实现落点是 `workflow` 工具（`tool-workflow`），执行侧是 `ctx.workflowEngine` 服务定义（`workflow`）与它的 PTC 实现（`workflow-ptc`），展示侧是客户端插件 `ui-workflow-run`。

## 1 能力边界

- **输入**：一段纯 JavaScript 脚本体（顶层 `await` 合法，末尾 `return` 一个 JSON 值）、一个作为数据的 `meta` 身份块、一个可选的 `args` JSON 对象。
- **执行**：脚本在独立环境中运行，只拿到 `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` 六个钩子；真正的活由钩子派生的子代理干。
- **输出**：脚本返回值（lossless JSON）加派生的 agent 数量，作为父会话里一次工具调用的结果。中途的子代理消息不进入父会话。
- **定位**：一个可选能力，不在 agent loop 里。一次调用阻塞父轮次直到整段脚本落定；用于多文件审计、迁移、多角度调研这类横向铺开的工作，一两次委派仍走普通 subagent。

## 2 包分组与职责

| 包 | 职责 | 注册位置 |
|---|---|---|
| `@deepseek-ai/dsh-workflow` | 服务定义：`WorkflowStartRequest` / `WorkflowRun` / `WorkflowResult` / `WorkflowMeta`、`WorkflowError`、`workflow/*` 事件声明 | `ctx.workflowEngine` |
| `@deepseek-ai/dsh-workflow-ptc` | 服务实现：把脚本放进 PTC Node 进程运行，VM 提供钩子，子代理走 `ctx.subagents` | 在 `ctx.workflowEngine` 上注册 |
| `@deepseek-ai/dsh-tool-workflow` | 模型侧消费者：`workflow` 工具的参数 schema、提示段落、结果信封、后台任务、会话持久记录 | 在 `ctx.tools` 上注册 |
| `@deepseek-ai/dsh-client-ui-workflow-run` | 展示：把持久记录折叠成会话里独立的工作流节点 | 客户端 Conversation Node |

一个上下文只允许一个引擎实现（像 bash 一样是部署级替换，不是多提供者共存）。

## 3 服务定义

### 3.1 启动请求

`start(request)` 在**发布一个 run 之前**同步校验：`meta` 形状、脚本能否编译、子代理路由是否存在、单次总 agent 上限是否超过部署上限。校验不过直接抛 `WorkflowError`，不产生 run。

| 字段 | 含义 |
|---|---|
| `script` | 脚本体文本 |
| `meta` | 身份块数据 |
| `args` | 暴露给脚本的 `args` 全局 |
| `subagentProvider` | 可选，本 run 的子代理路由覆盖 |
| `maxTotalAgents` | 可选，本 run 的总子代理上限（只能下调，不能超过引擎配置） |
| `parent` | 必填，每个子代理都归属到它；cwd、血缘、深度经 subagent 服务定义传递 |
| `signal` | 可选，取消 run |

`meta` 与 `args` 是**数据**，永远不被求值。脚本不能读取或替换 provider 与上限这类策略。

### 3.2 身份块 `WorkflowMeta`

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | kebab-case 短名，显示与持久化键 |
| `description` | 是 | 一行描述 |
| `whenToUse` | 否 | 何时适用的说明 |
| `phases` | 否 | 阶段声明数组，每项 `title` / `detail?` / `provider?` / `model?` |

严格模式：出现未识别字段即 `META_INVALID`，错误信息按字段名逐条列出。`phases` 只是进度词汇，`phase()` 按标题精确匹配，不构成执行结构。

### 3.3 活着的 run 与终态结果

`start()` 返回 `WorkflowRun`：`id`、`meta`、`result`、`cancel(reason?)`、`dispose()`。`result` **永不 reject**；脚本失败解析为 `stopReason: 'error'`，取消解析为 `'cancelled'`。run 归持有者所有：每个消费者都必须 `dispose()`，`dispose()` 幂等，取消后等待脚本与子代理真正静默。

`WorkflowResult` 字段：

| 字段 | 含义 |
|---|---|
| `value` | 脚本返回值（纯 JSON；脚本无 `return` 时为 `null`），只在 `completed` 时有意义 |
| `stopReason` | 封闭联合 `completed` / `cancelled` / `error` |
| `error` | 失败说明，非 `completed` 时存在 |
| `errorCode` | 终结该 run 的致命错误码；脚本自身异常或运行时故障时不存在 |
| `agentsStarted` | 整个生命周期内接受的 `agent()` 调用数；终止路径上退化为宿主观测到的数量 |

## 4 脚本契约

### 4.1 脚本形态

- 纯 JavaScript 函数体，不是 TypeScript；允许顶层 `await`；末尾 `return <value>`。
- 不允许 `export const meta = {...}`：meta 走参数。脚本体里带这条语句会被 `SCRIPT_PARSE` 明确拒绝。
- 返回值必须是 lossless JSON：普通对象/数组/标量；函数、symbol、`BigInt`、非有限数、嵌套 `undefined`、循环引用、稀疏数组、非普通原型的对象（`Date` / `Map` / 类实例）都判 `RESULT_UNSERIALIZABLE`。
- 脚本环境没有文件系统、网络、计时器或 Node API；活都由 agent 干。同步首片有 VM 时限（默认 5 秒），整段 run 没有总时限。

### 4.2 钩子

| 钩子 | 语义 |
|---|---|
| `agent(prompt, opts?)` | 跑一个子代理到落定。无 `schema` 时解析为子代理的最终文本；有 `schema` 时解析为校验过的结构化对象。子代理自身失败（非 `completed`）解析为 `null`。选项：`label`、`phase`、`provider`、`model`、`schema` |
| `parallel(thunks)` | 并发跑一组零参函数，全部等齐（屏障）。单个 thunk 抛普通错误解析为 `null` |
| `pipeline(items, ...stages)` | 每个 item 独立串起各 stage，**阶段之间没有屏障**；stage 收到 `(prev, item, index)`。普通 stage 抛错把该 item 落下为 `null` 并跳过其剩余 stage |
| `phase(title)` | 声明进度阶段；后续 `agent()` 默认归属该阶段，并发 `workflow/phase` 事件 |
| `log(message)` | 叙述一行进度，`workflow/log` 事件 |
| `args` | 工具调用 `args` 参数的原样数据 |

`agent()` 的 `schema` 只接受对象根 JSON Schema 的一个子集（`type` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` / `oneOf` 加注解关键字），越界判 `UNSUPPORTED_SCHEMA`。`effort` / `isolation` / `agentType` 是明确推迟的选项，出现即带名字拒绝。

### 4.3 失败纪律：致命与逐项 `null`

- **致命**（`WorkflowError`，`fatal: true`）覆盖：钩子误用（参数类型错、未知或推迟的选项）、schema 越界、触顶上限、子代理启动/结果的基础设施故障、边界值不可序列化、取消。`parallel()` / `pipeline()` 把致命错误**重新抛出**，整段脚本响亮地死掉，而不是化成一个读起来像「子代理失败」的 `null`。
- **逐项 `null`** 只留给孩子**自身**失败（非 `completed` 结束）与 stage 内的普通脚本错误。
- 致命性靠宿主侧 `instanceof` 判定，脚本侧构造的对象伪造不了。

### 4.4 协作上限

| 上限 | 默认 | 作用 |
|---|---|---|
| `maxConcurrentAgents` | `0` → `min(16, max(1, cores - 2))` | 同时在跑的子代理数；超出的调用按 FIFO 排队占位 |
| `maxTotalAgents` | `1000` | 单 run 累计 `agent()` 次数，防跑飞循环 |
| `maxItemsPerCall` | `4096` | 单次 `parallel()` / `pipeline()` 接受的 item 数 |
| `syncTimeoutMs` | `5000` | 脚本首个同步片的 VM 时限 |

这些是协作式配额，不是宿主强制的安全配额；脚本策略不可改，只有消费者能在启动请求里整体下调总上限或改路由。

## 5 执行引擎（workflow-ptc）

### 5.1 分层

- **宿主侧**（`host.ts`）：`PtcWorkflowRun` 持有取消控制器、子代理记录表（`callId → SubagentActivation`）、在途回调集合与活跃 agent 表；通过 JSON 绑定 `begin` / `startChild` / `childResult` / `disposeChild` / `progress` 暴露给 guest。
- **guest 侧**（`guest.ts` + `guest-source.ts`）：一段自包含程序被送进 PTC Node 进程，用 `node:vm` 建一个空上下文，把六个钩子与 `args` 挂上去运行脚本；进度按批（同一时刻至多一批在途）回传宿主。
- **执行器**（`runtime.ts`）：钩子实现、FIFO 并发槽、`agent()` 选项校验、组合子纪律、返回值跨 realm 物化。
- **物化器**（`realm.ts`）：把 VM realm 的值复制成宿主纯 JSON，路径级报错；渲染抛出值永不抛。

### 5.2 开始与结束的次序

1. 宿主校验 `meta`（`meta.ts`）并解析脚本（`node:vm` 只编译不执行，脚本对象丢弃）。
2. 解析子代理路由与总上限，判定并发上限。
3. 发布 run，发 `workflow/start`。
4. guest 第一次 `begin` 取到初始化数据（meta、body、args 副本、上限）后编译同一个异步包装并执行。
5. `agent()`：校验选项 → 查总上限 → 递增序号 → 等并发槽 → `startChild` → 发 `agent-start` → 等结果 → 发 `agent-end` → 释放槽。子代理结果回传 `{ output, structured?, stopReason }`。
6. 脚本落定后 `await drain()` 把未发的进度冲完，再返回结果；`workflow/end` 由宿主在 `result` 解析后发出，**不带**返回值。

### 5.3 取消与清理

- `cancel()` 立刻中止 PTC 进程，不再等 guest 确认；同时处置已发布的子代理，待启动的子代理在启动完成后也会被处置。
- `dispose()` = 取消（已取消则跳过）+ 等 `result`；run 在 `finally` 里发出中止、处置全部子代理、等全部在途绑定落定，并为仍活跃的 agent 补发 `agent-end`（`outcome: 'cancelled'`）。
- 引擎卸载不撤销已被接受的 run：run 捕获了它需要的服务句柄。

## 6 模型侧消费者（`workflow` 工具）

### 6.1 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `script` | 是 | 脚本体；参数描述写明「纯 JS 函数体、不用 TS、不带 `export const meta`、允许顶层 await、以 `return` 结束」 |
| `meta` | 是 | 身份块 `{ name, description, whenToUse?, phases? }` |
| `args` | 否 | 对象；裸列表要包字段 |
| `run_in_background` | 否 | 仅当部署启用后台时出现；立即返回 job id |

工具描述本身就是模型侧的脚本编写规格：钩子清单、各自语义、支持的 schema 子集、致命与 `null` 的分界。

### 6.2 前台生命周期

`execute` 启动 run，在 `try/finally` 里 `await run.result`，任何路径都 `dispose()`；工具 step 的 abort 信号桥接为 `run.cancel()`（含启动前已中止的情形）。非 `completed` 一律变成 `isError`：调用方中止沿用运行时的 `ABORTED`，取消报 `Error: workflow run was cancelled`，失败报 `Error: workflow run failed: <error>`，部分输出从不报告成成功。

### 6.3 结果渲染

成功返回信封 `{ kind: 'foreground', runId, agentsStarted, result }`，模型看到：

```text
workflow "<name>" completed (<count> agent<optional-s>).
Return value:
<pretty-printed JSON>
```

渲染上限 `maxResultChars`（默认 50000），超出截断并附 `… [truncated: <n> more characters]`。失败统一 `Error: <message>` 文本通道。展示层卡片标题取 `meta.name`，脚本原文作为输入展示。

### 6.4 后台生命

`run_in_background: true` 时工具把 run 注册成 `ctx.jobs` 的 `workflow` 任务，立即返回 `{ kind: 'background', jobId, runId }`，模型看到 `workflow "<name>" started in the background as job <jobId>. …`。run 在 job 的 starter 里启动，没有工具 step 信号：`job_kill`、任务列表的停止按钮、拥有者销毁才取消它。阶段、日志、成员生命周期经镜像写进 job 的输出环，进度行跟当前阶段走。落定即 job 落定：完成时返回值随完成通知与首次 `job_output` 到达，取消落 `killed`，失败落 `failed`。

### 6.5 持久记录与展示

顶层调用把 run 与成员生命周期写成四条 log-only 会话事件：`tool-workflow/run-start`（run 接受后）、`tool-workflow/agent-start`（按 `seq`，带 child session id）、`tool-workflow/agent-end`（按 `seq` 配对）、`tool-workflow/run-end`（结果已知且清理静默后）。首次写入失败即对本 run 关闭后续写入，留下空记录或合法前缀，不影响工具结果。嵌套调用不写记录。

`ui-workflow-run` 用这四条事件在会话里铺一个独立的 `workflow-run` 节点：run → 阶段 → 成员的嵌套折叠，运行/失败/取消/中断层级默认展开，完成层级默认收起；运行中的成员在属于当前会话且本地可用时可跳到子会话。节点只显示身份与状态，不显示脚本、输出、错误、日志或控制。

## 7 关系与边界

- **与 subagent**：普通 subagent 是「一两次委派」的默认手段；workflow 是「几十上百份」的编排。子代理结果由脚本收集，不进入父会话的中途消息流。
- **与 run_code / PTC**：脚本与 PTC 共用同一个 Node 进程运行时；文件策略、进程上限、终止都归 PTC 提供者，workflow 只决定编排。
- **与 ralph**：固定循环的 ralph 工具复用同一引擎，但显式开启才可用。
- **与计划态**：`meta.phases` 是进度词汇而非计划；DSH 不在 workflow 里内置「先审计划再执行」的环节。

## 8 已知限制

- 只做前台收集：调用方持有一个活 run 并等待；后台启动/轮询、spill 句柄、脱离式收集都推迟。
- 无日志化与恢复：脚本、子代理进度、中间值都不做检查点，进程重启不能续跑。
- 无保存式或嵌套式 workflow：只运行调用方现场给的脚本，脚本里没有 `workflow()` 钩子。
- 没有 token 预算词汇：上限只算并发、item 数与 agent 次数，不核算子代理消耗的 token。
- run 归持有者而非服务跟踪：引擎卸载不能发现独立活句柄。

## 来源

- `reference/deepseek-harness/packages/workflow/workflow`（服务定义）
- `reference/deepseek-harness/packages/workflow/workflow-ptc`（PTC 引擎）
- `reference/deepseek-harness/packages/workflow/tool-workflow`（模型侧工具）
- `reference/deepseek-harness/packages/client/ui-workflow-run`（展示）
- `reference/deepseek-harness/docs/subsystems/workflow.md`（子系统说明）
- `reference/deepseek-harness/.agents/notes/archived/feature/2026-07-05-dynamic-workflows.md`（设计决策与备选方案）
