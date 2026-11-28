# workflow（实现层）

对应原型：`../prototype/workflow.md`（能力族的完整机制）与 `../prototype/tools/workflow.md`（模型可见契约）。本项目面向模型的设计写在 `../../../runtime/workflow.md`，本文只做逐条对照。

## 当前实现

### 代码位置

| 层 | 位置 | 职责 |
|---|---|---|
| 机制 | `lib/workflow-runtime/` | `meta` 校验、校验子集、值物化、宿主侧 run 驱动（`execution.js`）与 worker 侧脚本执行（`script-worker.js`）：六个钩子、并发槽、组合子纪律；子代理经 `childPort` 注入 |
| 子域 | `core/workflow/` | run 注册与生命周期、把 `SubagentRuntime.startChild({ delivery: 'caller' })` 适配成 `childPort`、领域事件、结果清单 |
| 消费者 | `tools/workflow/` | `workflow` 工具的 `registry.json` 与 `run.js`：参数、指引段落、结果渲染、前台/后台两条路径 |
| 运行时能力 | `core/subagent-runtime.js` | `startChild({ delivery })`：与 `spawn` 共用创建与轮次执行，按 `delivery` 决定是否投递结算；实例在一轮结束后释放、唤醒时重建 |
| 主循环节点 | `core/loops/nodes/tool-execute/run.js` | 给工具暴露 `exec.workflowEngine` 与 `exec.subagentStartChild` |

### 模型可见契约

- 工具名 `workflow`；参数 `script` / `meta` / `args` / `run_in_background`，与原型一致。
- 工具描述沿用原型正文的钩子清单与语义。
- 系统提示段落名 `tool:workflow`，位置取 `TOOL_WORKFLOW`（2600）。
- 成功渲染 `workflow "<name>" completed (<count> agent<optional-s>).` 加 `Return value:` 与缩进 JSON，上限 `maxResultChars` 默认 50000。
- `meta` 与 `args` 是数据；`export const meta` 头部语句被拒绝。

### 执行环境

- 每次 run 一个 worker 线程，worker 内 `vm.createContext({})` 空上下文只挂钩子与 `args`；首片有 `syncTimeoutMs`（默认 5000）。
- worker 配 `resourceLimits`（512 / 64 / 8 MB）；钩子经 worker 消息往返，返回值在 worker 内先物化成纯 JSON。
- 没有独立进程，没有生成程序，没有 JSON 绑定命名空间。

### 运行事实

- 进度：`start()` 的 `onEvent` 把领域事件交给消费者；后台模式渲染成行写进 job 观察记录。
- 结果：留在工具调用行（`calls.arguments` 保存脚本与 `meta`，`calls.result` 保存渲染文本与 `meta`：`runId`、`name`、`stopReason`、`agentsStarted`、`engine`、`members`）。
- 成员：沿用 `subagents` 行与 `kind=subagent` 子会话；成员清单在 run 结果 `meta` 里。

### 配置

`user/settings.json` 的 `workflow` 段：`maxConcurrentAgents`（0 自动）、`maxTotalAgents`（1000）、`maxItemsPerCall`（4096）、`syncTimeoutMs`（5000）、`maxResultChars`（50000）。

## 与原型的关系

### 已对齐

- **脚本契约**：纯 JS 函数体、顶层 `await`、末尾 `return`；`meta` 走参数而不是脚本文本；`meta` 字段词表与校验规则一致。
- **六个钩子**：`agent` / `parallel` / `pipeline` / `phase` / `log` / `args`，含 `pipeline` 无阶段屏障与 `(prev, item, index)` 签名。
- **失败纪律**：致命错误穿透 `parallel` / `pipeline`，逐项 `null` 只保留给孩子自身失败与 stage 普通错误；`errorCode` 保留终结 run 的致命码。
- **结果形态**：`value` / `stopReason` / `error` / `errorCode` / `agentsStarted`；`result` 永不 reject；`dispose()` 幂等且等清理落定。
- **协作上限**：并发、单 run 总数、单次 item 数、首片时限四个上限与原型同名同义。
- **前台渲染**：`workflow "<name>" completed (<n> agents).` 加返回值，含截断提示；非 `completed` 一律 `isError`，部分输出不报成功。
- **后台形态**（契约已定）：立即返回 job id，阶段/日志/成员行进 job 观察记录，完成带返回值、取消 `killed`、失败 `failed`；本版没有 job 注册表，后台调用以错误结束并提示改走前台。
- **`agent()` 选项**：`label` / `phase` / `schema` / `provider` / `model` 支持，未知选项与 `effort` / `isolation` / `agentType` 带名字拒绝。

### 实现差异（已决定）

- **引擎分层**：原型把服务定义为 `ctx.workflowEngine` 一个抽象 `WorkflowEngine`，再挂一个 PTC 实现；本项目不引入 PTC 与独立进程，直接把机制放进 `lib/workflow-runtime`、把子域放进 `core/workflow`，不经服务注册表。理由：本项目没有第二套执行提供者的现实需求，多一层抽象只会多一套概念要对齐。
- **子代理交付**：与原型同构——`delivery` 是启动请求的一部分，由调用方固定（委派工具传 `parent`、workflow 传 `caller`），持久化在 `subagents.delivery` 上，模型与用户都不可选。差异只在于本项目没有 activation 对象，`caller` 的结果通过 `startChild` 返回的 Promise 交付。
- **执行隔离**：原型在独立 PTC Node 进程里跑脚本、按会话文件策略收束；本项目不实现沙箱，用 worker 线程加 `vm` 空上下文隔离模型写错的东西（不阻塞宿主、不耗尽宿主堆），而不是文件系统。依据 AGENTS.md 第 7 条。
- **取消与子代理**：原型的 run 持有子代理 activation 并统一处置；本项目 `AbortController` 逐级传到子代理轮次，`cancel` 处置已启动与在途的子代理。
- **不写独立的会话记录事件**：原型写四条 `tool-workflow/*` log-only 会话事件并配一个独立的 `workflow-run` 会话节点；本项目把运行事实放进既有的工具调用行（`meta.members`）与领域事件（见 `docs/runtime/workflow.md` 第 6 节），不新增表、不新增消息行。
- **不实现客户端节点**：原型有独立的 run → 阶段 → 成员折叠节点与子会话跳转；本项目暂不提供独立节点，成员信息留在工具结果的 `meta` 里供界面读取。
- **`structured` 结果**：原型 `agent({schema})` 的结果来自子代理的强制结构化输出；本项目的子代理没有强制结构化输出，`schema` 由 `startChild` 把 JSON Schema 作为输出要求注入子代理上下文，再对返回文本做严格 JSON 解析与最小字段校验，解析或校验失败按子代理自身失败处理（解析为 `null`，子代理停止原因记为 `error`）。

### 待对齐

- 独立展示节点：把 `calls.result` 的成员清单折叠成 run / 阶段 / 成员三层，运行中可跳到子会话。
- 每个子代理的 token 用量汇总到 run 结果，便于判断一次 workflow 的成本。

### 未实现

- **`ObjectJsonSchema` 的完整子集校验**：原型的 `assertObjectJsonSchema` 检查注解值是否为 lossless JSON、用迭代遍历避免深嵌套爆栈；本项目只做关键字白名单、对象根、`oneOf` 兄弟规则与字段类型。
- **进度批处理通道**：原型 guest 侧按批、同一时刻至多一批在途地回传进度；本项目每个 `phase` / `log` / 成员事件各走一条 worker 消息，没有批处理。
- **跨 realm 的致命性判定**：worker 与宿主各有一个 `WorkflowError` 类，`instanceof` 在跨界时不可靠；本项目用不可伪造的私有 symbol 标记宿主错误，组合子按该标记判定致命性。
- **取消时的成员补发**：原型在终止路径上为仍活跃的成员补发 `agent-end`（`cancelled`）；本项目在取消时处置已启动与在途的子代理，但不再为脚本侧仍挂起的调用补发成员事件——worker 已被抛弃，这些调用无从得知。

### 明确不做

- **PTC / `run_code` 执行器与 workflow 的融合**：本项目已实现独立的 `run_code` 入口，但 workflow 仍是 native 编排，不把脚本当作 PTC guest；两者共用“编排”和“进程执行”的表象，不共享执行器状态。
- **沙箱相关字段**：`agent({isolation})` 以及任何沙箱分支，依据 AGENTS.md 第 7 条。
- **嵌套 `workflow()`、journaling / resume、保存式 workflow**：与原型同为明确推迟项，本项目一并不做。

### 我们独有

- **实例在交付之外被释放**：原型由 `dispose()` 释放实例；本项目在子代理一轮结束且无待领输入时自动释放实例，唤醒时按规则重建，catalog 与历史不受影响。
- **worker 加 vm 的两层隔离**：原型用 PTC 进程提供隔离与终止；本项目用 worker 线程提供「不阻塞、可终止、有堆上限」，vm 只负责空全局。
- **`tools/workflow/registry.json` 声明式注册**：沿用本项目的工具加载方式。

## 后续计划

1. 独立展示节点与成员跳转。
2. 子代理用量汇总进 run 结果。
3. 补全 `ObjectJsonSchema` 解析与校验的完整子集。
