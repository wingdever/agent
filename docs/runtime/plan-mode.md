# Plan Mode（计划模式）设计与实现

## 定位

plan mode指在执行之前插入一个设计阶段，
先探索、拆解、呈现方案，经过确认后再动手。 

本项目中是一种 per-session 的运行态：
代理在该态下只做方案调研与规划，不直接落地变更。
它与 `docs/agent-mode.md` 中的 activity 轴耦合
——`activity=plan-mode` 即进入计划态，
切到其它 activity（典型为 `build-code`）即退出。

设计要点：

- 计划态通过 request-scoped 的 system prompt 约束模型行为，不修改持久化在 store 里的 system prompt，保证 request-cache 稳定。
- 工具目录在两种模式下保持一致（避免请求形状变化），但 plan-mode 的 POLICY 凌驾于任何工具描述之上，禁止模型使用变更类工具。
- 计划态的开关状态仅存于内存（`core/plan-mode.js` 的 `states` Map）。页面刷新保留 core 进程时状态仍在；core 进程重启则重置。

架构选择：

1. 约束强度：软指引 vs 硬门禁
我们只改变注入给模型的提示词，
说明"当前是规划模式,先不要执行"，
但不再执行层直接限制可用工具集。
2. 计划产物的形态与评审方式
计划形态：自由文本、JSON 或 Markdown。
评审方式：
    专用退出工具触发交互式审批
    用户直接编辑计划文件
    模式切换来隐式确认
3. 状态管理与恢复
我们通过将激活状态记录为会话日志中的事件支持恢复，
除此之外还可以将计划保存为工作区文件。
4. 模式切换的边界
用户和代理如何手动和自动切换模式
切换时上下文如何保留


## 状态存储

`core/plan-mode.js` 以 `sessionId -> true` 的 Map 记录激活态：

- `isActive(sessionId)`：返回是否处于计划态。
- `setActive(sessionId, active)`：激活时写入 `true`，退出时 `delete` 该键。
- `clear(sessionId)`：清空单会话或全表。
- 无 `sessionId`（空串 / null）时所有操作视为无效（`setActive` 返回 false，`isActive` 返回 false），避免把无会话调用方误置为计划态。

## 进入与退出计划态

### 驱动来源

`core/loops/linear.js` 与 `core/loops/node-graph.js` 在每轮 `chat()` 入口处根据 activity 同步开关：

```
planMode.setActive(sessionId, core.activity === "plan-mode");
```

即：选 `plan-mode` 即进入；切到其它 activity 即退出（见 `docs/agent-mode.md` 的 activity 流转说明）。

### 即时同步（UI 侧）

UI 在 activity 切换时通过 `App.syncPlanModeFromActivity()` 主动同步（不依赖发消息）：

- 计算 `App.getActivityMode() === "plan-mode"` 得 `active`。
- 写 `App.currentPlanMode = active`。
- 调 `AgentClient.call("planMode", { op: "set", ... })` 让 core 端状态与 UI 一致。

core 端 `planMode` 通道（`core/index.js`）支持两个 op：

- `op: "get"` → 返回当前 `isActive`。
- `op: "set"` → 经 `planMode.setActive` 设置并广播 `plan-mode` 事件。

core 端 `setPlanMode(sessionId, active)` 在状态变更时通过 `_onEvent` 广播 `type: "plan-mode", active` 事件，UI（`ui/web/chat-tab.js`）据此刷新 `App.currentPlanMode` 与界面指示器。

## POLICY 注入

1. 系统提示段落
参照@deepseek-ai/dsh-plan-mode中的提示词段落plan:policy，
`core/plan-mode.js` export `POLICY` section to sys_prom，
作为计划态下的行为约束，核心条款：

- 留在计划态直到用户经 `exit_plan_mode` 批准，或显式切换会话模式。
- 用户的口头同意（包括确认某个提问）不构成批准，也不退出计划态；确认的决策应并入计划、经 `exit_plan_mode` 提交。
- 先做只读调研（读文件、搜索、静态分析、检查），不编辑/写文件、不改配置、不跑会改写受控文件的格式化/代码生成、不 commit、不实施计划。
- 工具目录跨模式不变，计划态规则凌驾于工具描述；不要用 `todo_write` 跟踪本阶段（它跟踪批准后的实施）。
- 能用检查确定的事实就用检查，只对用户所有或检查无法回答的歧义用 `ask_user_question`。
- 计划要 decision-complete：目标与成功标准、按子系统分组的改动、公共 API/ schema / 数据流变更、边界与失败模式、测试与验收标准、显式假设。
- 就绪时调 `exit_plan_mode` 提交以 `#` 标题开头的完整 markdown 计划，且应为该 assistant 轮里唯一且最后的工具调用。

2. 模式切换通知（user/message 通知）
DSH 在模式真正跨边界时向模型注入一条插件来源的 user/message 通知（form:notice），仅在"上一轮请求头描述的状态与本次要切换到的状态不同"时才记录，使模型恰好在上下文变化的那一刻被告知一次、绝不冗余。本项目已复刻该习惯：
- `core/plan-mode.js` 新增 `lastHeaderActive[sessionId]` 快照（对应 DSH 的 `activeAtLastHeader`）：每个 step 请求前由循环调用 `recordHeader` 刷新为当前 `isActive` 值。
- `setActive` 在状态发生跨边界变化、且 `lastHeaderActive` 已记录（`!== undefined`）且与目标不同时，决定一条通知文本（进入：`The user switched this session to plan mode.`；退出：`The user switched this session back to the default mode.`），暂存进 `pendingNotices`。首轮进入 plan mode 不通知（由 POLICY 段落自身传达），与 DSH 一致。
- 通知在请求装配点消费（`linear.js` r 循环顶部、`model-request` 节点）：作为 `role:"user"` 追加进 `conv`（位于 user 前缀之后，对应 DSH 的 "after the reusable request prefix"），并以 `message.add` 落库（persist 时），使其随 surface replay 可见；`takeNotices` 取出即清空，保证每轮只推送一次、后续重放由 surface 自带而不重复。
- exit_plan_mode 批准退出走 `requestExit`/`applyPendingExit`（narrate:false），不生成通知，模型通过工具结果 `{approved:true}` 文本与下一轮 POLICY 消失感知退出，与 DSH 一致。

### 注入位置

POLICY 以 request-scoped 方式拼接进每步请求的 system：

- linear 循环：`requestSystem = system + (planMode.isActive(sessionId) ? "\n\n" + POLICY : "")`，每步请求前重新计算（含自动压缩后的重算）。
- node-graph：`core/loops/nodes/model-request/run.js` 与 `core/loops/nodes/auto-compact/run.js` 同理写入 `ctx.requestSystem`。

`exit_plan_mode` 批准后会翻转状态，下一轮该政策自动消失。

## 计划审批流程

### 触发

模型调用 `exit_plan_mode` 工具（注册于 `tools/exit_plan_mode/registry.json`，`type: "plan"`）提交计划。`tools/exit_plan_mode/run.js` 的校验与流程：

- 非计划态调用直接抛错（依赖 `exec.isPlanMode()`）。
- `plan` 必须是字符串，且匹配 `/^#\s+\S/`——即非空、以 `#` 标题开头；否则抛错。
- 若 `exec.reviewPlan` 不可用，抛错提示应改用手动切模式。
- 调 `exec.reviewPlan(plan)` 挂起等待 UI 审批。

### 挂起与恢复（core 侧）

`core/index.js` 的 `requestPlanReview({ callId, plan, sessionId })`：

- 自增 `planReviewSeq` 生成审批 id，存入 `pendingPlanReviews` Map（resolve 函数 + sessionId）。
- 广播 `type: "model-http-status", state: "on-wait"` 表示已挂起等待。
- 广播 `type: "plan-review", id, callId, plan, title`（title 取自 `firstHeading(plan)`，缺省 `"Plan"`）。

UI 侧的 `answerPlanReview(id, payload)`：

- 取 `pendingPlanReviews[id]`，存在则删除并解析 `approved` / `feedback`。
- `approved === true` 时调 `planMode.requestExit(sessionId)` 登记待退中间态（**不立即翻转**），并立即广播 `type: "plan-mode", active: false` 让 UI 指示器即时退出；`isActive` 在 pending 期间仍返回 true，故本批剩余工具仍受 POLICY 约束。
- `pending.resolve({ approved, feedback })` 让 `exit_plan_mode` 工具得以继续。

### 结果处理

`exit_plan_mode/run.js` 据 `reviewPlan` 返回的 `answer`：

- 批准：返回 `{ text: "Plan approved — ...", meta: { approved: true } }`。真正的模式翻转经待退中间态延迟到下一轮 pre-step 才生效（见下文"待退中间态"）。
- 不批准：以用户反馈（或默认文案）构造 `Error` 抛出，该错误作为工具结果回灌模型，模型据此修订并再次提交。

### UI 审批卡片

`ui/web/chat-tab.js` 的 `renderPlanReview(card, evt)` 渲染计划审批卡片：

- 标题 `计划审批：<evt.title>`。
- 正文用 markdown 渲染 `evt.plan`。
- 一个可选 feedback 文本框（不批准时填写修改意见）。
- 两个按钮：`继续计划`（keep，approved=false）与 `批准并退出计划模式`（approve，approved=true）。
- 点击经 `AgentClient.call("answerPlanReview", { id, approved, feedback })` 提交；成功后显示 `已批准，计划模式已退出` 或 `已退回，继续计划`，并禁用控件。

### 模型感知退出

通过工具 exit_plan_mode 的返回值感知，批准后的停用则通过提示词消失体现
在 Plan Mode 外调用会失败；在 Plan Mode 内调用时，它通过用户提问接缝呈现计划供评审。
批准之后，模型在后续请求中感知到“已退出”的方式，是 plan:policy 段落不再出现，
这里并没有显式的"已退出计划模式"日志事件被塞进上下文。
1. 批准：
返回规范的 { approved: true }，同时记录一个静默的、待定的退出，
该退出在下一个被接受的轮内 pre-step 才正式追加。
工具结果本身会向模型报告这个转换，但计划引导文本在当前工具批次的剩余部分仍然保持激活，
直到那个 pre-step 真正提交停用状态。

## 待退中间态（pending exit）

为实现 DSH 的"批准不立即退、当前工具批次仍受约束、下一轮 pre-step 才翻转"语义，本实现用内存 `pendingExits` Map（按 sessionId）承载待退状态，与 `states` 分离。

### 状态函数（`core/plan-mode.js`）

- `requestExit(sessionId)`：仅当 `states` 为 active 时登记 `pendingExits[sessionId]=true`，返回是否新登记。手动 `setActive(false)` / `clear` 会一并清掉 pending。
- `isActive(sessionId)`：pending 期间仍返回 true——本批后续工具调用继续受 POLICY 约束。
- `applyPendingExit(sessionId)`：在下一轮 pre-step 消费 pending，真正 `states.delete` 并返回是否翻转；幂等。
- `hasPendingExit(sessionId)`：查询待退状态。

### pre-step 落点（真正翻转点）

- linear：在 `for (let r...)` 循环顶部、`r > 0` 时（即非首轮）调用 `applyPendingExit`，随后重算 `requestSystem`。本批（批准所在的那一轮）所有工具已在翻转前执行完，故仍受约束；下一轮 `requestSystem` 已无 POLICY。
- node-graph：在 `auto-compact` 节点（每个 step 请求前的 pre-step）调用 `applyPendingExit`，再据此重算 `ctx.requestSystem`，与 DSH 的 next in-turn pre-step 对应。

### UI 即时性

`answerPlanReview` 在批准当刻已广播 `plan-mode: false`，UI 指示器立即显示已退出；但 core 内存态延迟到下一轮 pre-step 才真翻。两者短暂不一致是可接受的：`isActive` 在 pending 期间保持 true 仅作用于"本批剩余工具是否带 POLICY"，对用户可见的指示器无影响。

### 与 DSH 的差异

- DSH 把待退作为 `plan/mode` 日志事件、在 pre-step 追加，以支持 resume / fork / compaction 从日志恢复；本实现仅存内存，core 重启即失（与 plan 态整体不持久化的既定设计一致）。
- DSH 的批准是"静默待退 + 工具结果报告转换"；本实现等价，且无显式退出日志事件塞入模型上下文（模型通过下一轮 POLICY 消失感知退出）。
2. 拒绝或要求继续规划：
返回携带用户反馈的失败调用，模型留在 Plan Mode 中，根据反馈修订计划后再次呈交。

## 链路节点

`core/loops/nodes/plan-review/run.js` 是节点图上的薄透传节点：实际的计划审批由 `exit_plan_mode` 工具执行期经 `requestPlanReview` 回调挂起完成，并非独立顺序阶段。该节点不单独处理审批，仅把控制流转给 `decide-next` 以维持文档拓扑。

## 不变式与边界

- 计划态禁止变更类工具的语义来自 POLICY 文本对模型的约束，而非在工具层硬拦截（与 `docs/agent-mode.md` 的「agent 层只注入 Mode、行为交模型」一致）；真正落地的硬闸门仍是 permission gate 与 fs-policy。
- 计划态不持久化：core 重启即失，UI 若需恢复一致性应重新按 activity 同步（经 `syncPlanModeFromActivity`）。
- 无 `sessionId` 的调用方不参与计划态（避免 bare-chat 等无会话路径被误置）。

## 与 DSH 契约的对账

DSH 的 `exit_plan_mode` 模型通信契约（来源：`reference/deepseek-harness/docs/subsystems/plan.md` 与 `plan/plan-mode/src/index.ts`）核心条款，逐项核对本项目实现：

| DSH 契约 | 本实现 | 状态 |
|---|---|---|
| 工具常驻 schema：进入/退出只改 prompt section，不改工具目录 | `registry.json` 始终注册 `type:"plan"`；循环仅切 POLICY，不改目录 | 一致 |
| 非 plan mode 调用失败 | `exec.isPlanMode()` 校验 | 一致 |
| `plan` 非空且以 `#` 标题开头 | 同 `/^#\s+\S/` | 一致 |
| 审批通道缺失/审查中断：抛错而非静默退出 | `reviewPlan` 不可用即抛错 | 一致 |
| keep-planning = 失败调用带反馈，模型修订再提交 | 抛 `Error(feedback)` 回灌 | 一致 |
| 批准返回 `{approved:true}` | `meta:{approved:true}` + 同文案 | 一致 |
| 批准不立即退出，本批仍受约束，下一轮 pre-step 才翻转（pending exit） | `requestExit` + 内存 `pendingExits`，下一轮 pre-step（`linear` 顶部 / `auto-compact`）`applyPendingExit` | 一致 |
| 用户主动切模式注入 user/message 通知，仅当上一轮 header 描述另一态时发一次 | `lastHeaderActive` 快照 + `setActive` 决定 + `takeNotices` 落库推送 | 一致 |

### 仍存在的偏离

- **审批通道身份**：DSH 把 plan review 复用为 user-questions seam 的一个带 `intent:{kind:'plan-review'}` 的提问，底层仍是 ask 通道；本实现另起独立 `plan-review` 事件 + `pendingPlanReviews` + `answerPlanReview` 通道，功能等价但未走 user-questions seam。若日后做 DSH 出向兼容，需归一。
- **UI 呈现契约**：DSH 用 `defineTool` 的 `presentCall` / `presentResult` 字段把工具在 UI 的呈现封进工具定义本身（属 host↔client 呈现协议，不进入模型通信）；本实现用 `plan-review` 事件 + `renderPlanReview` 等效渲染，路径不同但结果等价。
- **持久化**：DSH 的 plan 状态与通知均作为 `plan/mode` / `user/message` 事件落日志，支持 resume / fork / compaction 从日志恢复；本实现仅存内存（plan 态整体声明不持久化，core 重启即失），故无此恢复能力。这与项目既定设计一致，非缺陷。