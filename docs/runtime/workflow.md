# workflow 编排

## 范围

workflow 是 agent 的**脚本化横向铺开**能力：模型写一段纯 JavaScript 脚本，脚本通过 `agent()` 钩子派生子代理，最终返回一个 JSON 值，作为这一轮工具调用的结果回到父会话。子代理的中途输出由脚本收集，不进入父会话的消息流。

本支记录这套能力的现状设计：它与本项目 subagent 委派模型的关系、脚本契约、运行期的资源与生命周期、模型侧工具契约、事件与执行面的边界。DSH 的参照原型见 `../../path/dsh/prototype/workflow.md`；两侧的逐条对照见 `../../path/dsh/achievement/workflow.md`。

## 1 定位与边界

- **与 subagent 的分工**：一两次委派走 `subagent` / `subagent_fork`；几十上百份互不依赖的同类工作（审计一批文件、迁移一批模块、多角度调研、对发现做对抗式核验）走 workflow。判据是「委派次数」与「是否需要把中间结果留在脚本里互相组合」。
- **与 agent-role 的分工**：workflow 本身不定义角色，它只是「并行器 + 结果汇总器」；谁在干由 `agent()` 派生的子代理决定。
- **不是计划态**：`meta.phases` 与 `phase()` 只是进度词汇，供 UI 分组；不构成执行结构，也不产生「先审计划再执行」的门。
- **不是工具执行器**：本项目只有 native 一种执行器，`run_code` / PTC 不存在。workflow 脚本不是「另一种调工具的方式」，它只是编排；真正执行读写文件、跑命令的仍然是子代理各自轮次里的工具调用。
- **不承载长期状态**：workflow 不建自己的持久表，运行事实全部经既有的事件与工具调用行记录（见第 6 节）。

## 2 与 subagent 委派模型的关系

委派与结果的交付由 **delivery 策略**决定，它随每次启动固定下来并持久化在 `subagents.delivery` 上：

| delivery | 启动方 | 结果去向 |
|---|---|---|
| `parent` | `subagent` / `subagent_fork` 工具 | 轮末把结算消息作为一条 **follow-up 轮次**投进父会话 |
| `caller` | workflow 脚本的 `agent()` | 只落在 `startChild` 返回的 Promise 上，由调用方自取；`parent` 永远收不到通知 |

workflow 需要**同步拿到每个子代理的最终文本**，而 `parent` 交付走父会话的 follow-up。两条路可选：

- **走 inbox**：父轮次要等自己 inbox 里的结算消息，但父轮次正被 workflow 工具调用占着，结算消息只会落进 `nextTurn`，形成自等。不可行。
- **`caller` 交付**：同一次子会话创建与轮次执行，只是不投递结算，结果通过 Promise 交给调用者。

本设计取后者。`startChild({ delivery })` 是 `spawn` 与 workflow 共用的唯一入口；两条交付路径共享子会话创建、命名分配、实例隔离、权限与工具面，分叉点只在「落定后怎么交付」。

`delivery` 与「实例是否驻留」「是否进 catalog」「能否被 `send_message` 唤醒」**互相独立**：

- 两种 delivery 都写入 `subagents` 行，都出现在 `list_agents` 与树里，都占用同父唯一的名字；
- 两种 delivery 的子代理都可以被 `send_message` 唤醒，唤醒时沿用该行记录的 delivery；
- caller 子代理被唤醒后的结果同样无人认领——回复会作为该子会话自己的轮次落库，打开子会话能读到，但不会推送到父会话。

## 3 脚本契约

### 3.1 输入

一次工具调用给出三样东西：

| 参数 | 形态 | 说明 |
|---|---|---|
| `script` | 字符串 | 纯 JavaScript 函数体；允许顶层 `await`；末尾 `return <json>` |
| `meta` | JSON 对象 | 身份块；运行前按字段逐个校验 |
| `args` | JSON 对象 | 可选；原样暴露为脚本的 `args` 全局 |

`meta` 与 `args` 是**数据**，永不求值。脚本体里出现 `export const meta = {...}` 这类头部语句直接拒绝（`SCRIPT_PARSE`），提示把它挪进参数。

### 3.2 身份块

| 字段 | 必填 | 校验 |
|---|---|---|
| `name` | 是 | 非空字符串；显示与日志键 |
| `description` | 是 | 非空字符串 |
| `whenToUse` | 否 | 字符串 |
| `phases` | 否 | 数组，每项是 `{ title, detail?, provider?, model? }`，`title` 非空 |

未识别字段即拒绝，错误信息按字段名逐条列出。归一化后的 `meta` 与调用方传入的对象不共享引用。

### 3.3 钩子

| 钩子 | 语义 |
|---|---|
| `agent(prompt, opts?)` | 派生一个子代理并等它落定。`opts` 支持 `label` / `phase` / `provider` / `model` / `schema`。无 `schema` 解析为最终文本；有 `schema` 解析为结构化值。子代理**自身**失败（非 `completed`）解析为 `null` |
| `parallel(thunks)` | 并发跑一组零参函数，全部等齐。单个 thunk 抛普通错误解析为该位 `null` |
| `pipeline(items, ...stages)` | 每个 item 独立串联各 stage，阶段之间无屏障；stage 收到 `(prev, item, index)`；普通抛错把该 item 落为 `null` 并跳过其剩余 stage |
| `phase(title)` | 设当前进度阶段；之后的 `agent()` 默认归属它，并发出进度事件 |
| `log(message)` | 发一行进度叙述 |
| `args` | 工具调用 `args` 的原样副本 |

`schema` 只接受对象根 JSON Schema 的子集：`type` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` / `oneOf` 加注解关键字；越界即 `UNSUPPORTED_SCHEMA`。`effort` / `isolation` / `agentType` 属明确推迟项，出现时错误信息点名字。

### 3.4 返回值

返回值必须是可无损 JSON 化的纯数据：普通对象、数组、标量。`BigInt`、函数、symbol、非有限数、嵌套 `undefined`、循环引用、稀疏数组、非普通原型的对象一律判 `RESULT_UNSERIALIZABLE`。脚本无 `return` 时结果为 `null`。

### 3.5 失败纪律

- **致命**：钩子误用（参数类型错、未知或推迟的选项）、schema 越界、触顶上限、子代理基础设施故障、返回值不可序列化、取消。致命错误被 `parallel()` / `pipeline()` 重新抛出，整段脚本终止并带上错误码。
- **逐项 `null`**：只给孩子自身失败与 stage 内的普通脚本错误。
- 分界的意义是：模型写错一个选项名，必须响亮地失败，而不是表现成「某个子代理没干活」。

## 4 运行期

### 4.1 机制在 lib、策略在 core

- `lib/workflow-runtime` 是纯函数与纯数据模块：`meta` 校验、脚本编译与执行、钩子实现、并发槽、组合子纪律、跨上下文的值物化。它不碰会话、不碰存储，子代理以 `childPort` 注入——与 `lib/todo-state`「机制在 lib、重置时机在 core」同一形状。
- `core/workflow` 是子域：把 `SubagentRuntime.startChild({ delivery: 'caller' })` 适配成 `childPort`，管理 run 的注册、取消与并发，产出领域事件，并负责把进度记录到运行事实里。
- `tools/workflow` 是模型侧消费者：参数 schema、提示段落、结果渲染、执行期把 `exec.signal` 桥接成取消。

### 4.2 执行环境

脚本在**独立 worker 线程**里的 `vm` 上下文中运行：

- **线程**：每次 run 一个 `worker_threads.Worker`，跑完即终止。脚本因此既阻塞不了 agent 进程，也饿不死它；worker 配 `resourceLimits`（老生代 512 MB、新生代 64 MB、栈 8 MB），Node 对 worker 堆的记账计入进程总量，一个跑飞的脚本不会耗尽宿主堆。
- **上下文**：worker 内 `vm.createContext({})` 得到的空全局只挂六个钩子与 `args`，脚本看不到 `process`、`require`、其他会话状态。
- **钩子通道**：钩子由宿主实现，经 worker 消息往返：`agent()` 发 `agent-start`，宿主派生子代理并回 `agent-end`（含文本或结构化值）；`phase` / `log` 单向上报；取消由宿主发 `stop`，worker 直接以取消结果收尾，不再把错误投回脚本。
- **返回值**：worker 内先把返回值物化成纯 JSON 再发送，避免结构化克隆先抛出难以定位的 `DataCloneError`。

这一选择的前提是本项目不实现沙箱（AGENTS.md 第 7 条：工具直接作用于真实系统，唯一安全边界是权限门）。`vm` 与 worker 在这里的角色是**隔离模型写错的东西**（不阻塞、不污染宿主），不是安全边界；脚本能做的事都被限制在「派生子代理」，真正的写操作发生在子代理各自的权限门之后。

同步首片设 VM 时限（默认 5 秒）。首片之后脚本只有在 `await` 钩子时才让出；由于钩子跨越线程边界，脚本在首片以外的自旋只会占住自己的 worker，取消时整条 worker 被终止。

### 4.3 并发与上限

| 上限 | 默认 | 说明 |
|---|---|---|
| `maxConcurrentAgents` | `0` → `min(16, max(1, cores - 2))` | 同时在跑的子代理数；超出的调用按 FIFO 排队占槽 |
| `maxTotalAgents` | `1000` | 单 run 累计 `agent()` 次数，防跑飞循环 |
| `maxItemsPerCall` | `4096` | 单次 `parallel()` / `pipeline()` 接受的 item 数 |
| `syncTimeoutMs` | `5000` | 脚本首片时限 |
| `maxResultChars` | `50000` | 结果渲染字符上限，超出截断并附提示 |

这些上限由 `user/settings.json` 的 workflow 段覆盖，每次启动 run 时读取，改配置对下一次 run 生效。它们是协作式配额：约束正常脚本，不构成安全配额。

### 4.4 生命周期

一次 run 从 `start()` 到 `dispose()` 的路径：

1. 校验 `meta`（不通过即抛，不产生 run）。
2. 编译脚本体（只编译不执行；不通过即抛）。
3. 解析本次 run 的上限与子代理路由。
4. 发布 run，登记为活跃 run，发 `workflow-start`。
5. 脚本执行：每次 `agent()` 走并发槽、派生子代理、等落定，发 `workflow-agent-start` / `workflow-agent-end`。
6. 脚本落定：物化返回值。
7. `result` 解析（永不 reject），发 `workflow-end`，释放并发槽，从活跃表摘除。

### 4.5 子代理实例的驻留与释放

一个子代理一轮结束、且没有待领取输入后，它的实例从 Agent 注册表移出：会话事实（轮次、步骤、消息、调用）早已落库，实例只是运行时态。之后再被唤醒时，运行时按规则重建实例与上下文（默认工具集 + 当前模型配置），而不是重放创建时的快照。

释放推迟一拍执行，并复查「该子代理没有新一轮在跑、没有待领取输入」；否则一轮刚结束时紧接着到达的消息会被丢。

规则对所有子代理一致，不分 delivery。

- **取消**：`cancel(reason)` 是幂等的，第一次调用生效。宿主向 worker 发 `stop`，worker 以取消结果收尾；排队中的 `agent()` 调用不再派发，已启动与在途的子代理全部处置。脚本被抛下原地，不把取消投回脚本（否则脚本可以捕获并继续，或让驱动挂在无人结算的 Promise 上）。工具 step 的 abort 信号在工具层桥接为 `cancel`。
- **处置**：`dispose()` = 取消（已取消则跳过）+ 等 `result` + 等所有子代理的处置落定。消费者在 `finally` 里调用，任何路径都要走。
- **父轮次**：前台模式下 run 落在工具调用里，父轮次在 `run.result` 之前不结束。

### 4.6 结果形态

run 的终态结果：

| 字段 | 含义 |
|---|---|
| `value` | 脚本返回值（纯 JSON，`null` 表示无返回值），仅 `completed` 时有意义 |
| `stopReason` | `completed` / `cancelled` / `error` |
| `error` | 失败说明，非 `completed` 时存在 |
| `errorCode` | 终结 run 的致命错误码；脚本自身异常或无码失败时为空 |
| `agentsStarted` | 整个生命周期内接受的 `agent()` 调用数 |

## 5 模型侧契约

### 5.1 工具声明

工具名 `workflow`，参数为 `script`（必填）、`meta`（必填）、`args`（可选）、`run_in_background`（可选，默认下发）。工具描述本身就是脚本编写规格：钩子清单、各自语义、schema 子集、致命与 `null` 的分界。

### 5.2 系统提示段落

工具自带一段指引，段落名 `tool:workflow`，在提示词里的位置取 `TOOL_WORKFLOW`（2600）这个固定序号，不从属于其他工具的段落：

```text
Use the `workflow` tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.
```

### 5.3 前台结果

成功时模型看到：

```text
workflow "<name>" completed (<count> agent<optional-s>).
Return value:
<pretty-printed JSON>
```

渲染上限 `maxResultChars`（默认 50000），超出按字符截断并附一行 `… [truncated: <n> more characters]`。失败统一走文本错误通道：

| 情形 | 文本 |
|---|---|
| 调用方 step 被中止 | `Error: tool call aborted` |
| run 被取消 | `Error: workflow run was cancelled<(" (reason)")?>` |
| 脚本失败 | `Error: workflow run failed: <error>` |
| meta / 脚本校验失败 | `Error: invalid meta: <逐条>` / `Error: workflow script does not parse: <原因>` |

部分输出从不报告成成功。

### 5.4 后台结果

`run_in_background: true` 时工具立即返回 `workflow "<name>" started in the background as job <jobId>. …`，并登记为该会话的一个 job；阶段、日志、成员生命周期写进 job 的观察记录：

```text
▸ <phase>
<log message>
agent #<seq> <label> started
agent #<seq> <completed|failed|cancelled>
```

job 落定时 job 状态映射为：完成带返回值，取消 `killed`，失败 `failed` 并带错误信息。`job_kill` 与列表的停止按钮都取消 run。

本版没有 job 注册表（`exec.startJob` 不存在），后台调用直接返回 `Error: background workflow runs require a job registry, …`，让模型改走前台而不是把轮次挂住。

### 5.5 适用判据

- 用户显式要求 workflow 或大规模多代理编排时使用。
- 一两次委派用 `subagent` / `subagent_fork`。
- 需要把中间结果互相组合、按 item 独立推进、或并发规模超出「一轮里手写几个委派」时，才值得写脚本。

## 6 事件与执行面

### 6.1 领域事件

run 的生命周期与脚本叙述走进程内的 emit 事件，载荷都是**数据快照**（run id 与 meta），不携带可控制 run 的句柄；取消与处置只属于持有 run 的工具层：

| 事件 | 载荷 | 时机 |
|---|---|---|
| `workflow-start` | run 身份 | 发布 run 时 |
| `workflow-phase` | run 身份、阶段标题 | 每次 `phase()` |
| `workflow-log` | run 身份、消息 | 每次 `log()` |
| `workflow-agent-start` | run 身份、成员信息 | 子代理发布后 |
| `workflow-agent-end` | run 身份、成员信息与结局 | 成员落定或 run 终止补发 |
| `workflow-end` | run 身份、结果摘要（不含返回值） | `result` 解析后 |

监听者失败只记告警，不影响执行。

### 6.2 运行事实

**运行中的进度**交给已有的观察面：每次 run 通过 `start()` 的 `onEvent` 回调把领域事件交给消费者，消费者决定去向。后台模式把它们按 `renderProgress` 渲染成进度行写进 job 的观察记录。前台模式本版不额外广播进度，模型只看到最终结果。

进度行渲染：

```text
▸ <phase>
<log message>
agent #<seq> <label> started
agent #<seq> <completed|failed|cancelled>
```

**结果**留在工具调用行本身：`calls.arguments` 保存 `meta` 与 `script` 原文，`calls.result` 的 `meta` 保存 `runId`、`name`、`stopReason`、`agentsStarted`、`engine` 与成员清单（`seq` / `label` / `phase` / `childId` / `outcome`；运行中尚未落定的成员 `outcome` 为 `running`），渲染文本里是 `workflow "<name>" completed (<n> agents).` 与返回值。不新增表、不新增消息行。

**成员归属**沿用既有结构：每个子代理是一行 `subagents`（`par_sess_id` = 父会话）加一个 `kind=subagent` 的会话。工具调用与成员的对应关系记在结果 `meta.members` 里。

**重启语义**：进程退出时正在跑的 run 随之消失；`calls` 行回读时，未落定的工具调用保持 `pending`，UI 按「进行到一半」展示，与既有工具调用的中断语义一致。workflow 不做检查点与续跑。

## 7 控制面

- **取消**：前台随父轮次中止；后台随 `job_kill` 或会话销毁。
- **成员可控**：子代理仍是普通子会话，`list_agents` 能看到、`interrupt_agent` 能停、`send_message` 能续。workflow 不给成员另造控制通道。
- **不递归**：脚本里没有 `workflow()` 钩子；workflow 只运行被调用方现场给出的脚本。

## 8 失败与重启

- 校验失败（`META_INVALID` / `SCRIPT_PARSE`）在发布 run 前抛出，模型能从错误文本里纠正。
- 执行期失败按致命 / 逐项 `null` 分界处理；run 的 `errorCode` 保留终结它的致命码。
- 进程退出丢失进行中的 run，不续跑；已经落库的工具调用行保持未完成状态。

## 9 测试

- `test/workflow-runtime.test.js`：直接对 `lib/workflow-runtime` 断言钩子语义——`agent()` 的选项校验与 `null` 语义、`parallel` / `pipeline` 的致命穿透与逐项 `null`、上限触发、返回值物化、`meta` 校验。
- `test/workflow.test.js`：用假的 `childPort` 驱动 `core/workflow` 的 run，覆盖生命周期事件、取消、处置与并发上限，并端到端跑一次工具调用（参数校验、渲染、前台与后台两条路径）。
