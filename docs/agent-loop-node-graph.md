# 节点化、支持 Hook 的 Agent-Loop 引擎设计

> 状态：设计稿（grill 共识，待实现）。本文档描述第二种 agent-loop 引擎（代号
> `node-graph`）的架构；它与现有引擎（`linear`，即当前 `core/index.js` 的 `chat()`
> 主循环）并存，由环境变量 `AGENT_LOOP_ENGINE` 选择（实现层配置，与 `AGENT_TRANSPORT` 一致，不进入用户 `settings.json`）。

## 1. 目标

- 把现有 `chat()` 中隐式的、写死在主循环里的阶段（输入翻译、模型解析、system 装配、
  上下文拼装、自动压缩、模型请求、工具审批/执行、输出翻译、plan 审批、step 循环判定）
  **显式化为一组节点（Node）**。
- 提供**生命周期 hook**：在节点的标准槽位（`before` / `after` / `onError`）上注册回调，
  hook 可修改输入输出、阻止执行、改变流程走向。
- 现有行为**不退化**：`node-graph` 的默认编排在能力上等价于 `linear`。

## 2. 顶层架构：统一入口 + 引擎注册表

仿照 `core/transports/` 与 `core/tools/` 的注册模式，新增 `core/loops/`：

```
core/loops/
  index.js            # 引擎注册表 + getLoop(name)
  linear.js           # 现有 chat() 主循环搬来的引擎（runLoop(ctx)）
  node-graph.js       # 节点图引擎（调度器 + 默认节点表）
  registry.js         # loadNodes()：扫描 core/loops/nodes/*/registry.json
  builtins/           # 预定义但非主干的节点（如 translate-input / translate-output）
    translate.js
  nodes/              # 目录化节点（每个节点一个目录，含 registry.json + run.js）
    resolve-input/
    resolve-model/
    assemble-system/
    build-context/
    auto-compact/
    model-request/
    tool-approve/
    tool-run/
    plan-review/
    decide-next/
    builtin.translate-input/    # type: builtin
    builtin.translate-output/   # type: builtin
```

`core/index.js` 的 `chat()` 改为：参数归一 → 选引擎（`process.env.AGENT_LOOP_ENGINE`，默认
`linear` 以保向后兼容）→ 调用 `engine.runLoop(ctx)`。`linear` 与 `node-graph` 共用同一
批 core 方法（`_stream` / `requestApproval` / `tool.run` 等），只差"调用方是函数循环
还是节点调度器"。

## 3. 节点（Node）契约

### 3.1 目录与 registry.json

每个节点一个目录 `core/loops/nodes/<node-id>/`，含 `registry.json` 与 `run.js`
（`entry` 默认 `run.js`），**参照 `tools/` 的目录化注册机制**。

`registry.json` 字段：

```json
{
  "id": "model-request",
  "next": "tool-approve",
  "type": "core",
  "hooks": { "before": [], "after": [], "onError": [] },
  "entry": "run.js"
}
```

- `next`：默认下一节点 id；可被节点 `run()` 返回值或 hook 的 `goto` 覆盖。
- `type`：
  - `"core"`：主干节点，参与默认编排的 `next` 链，引擎自动调度。
  - `"builtin"`：预定义但**不在默认 `next` 链上**的二级节点（如 translate-input /
    translate-output）。有 `run()`、有自己的 `next`（指向它要回归的主干节点），但只有被
    hook 显式调用时才执行。
- `hooks`：槽位声明；运行时由 `registerHook` 填充，不在此写死具体逻辑。

### 3.2 run() 签名

```js
// node.run(input, ctx) -> { output, next?, done? }
// 可抛错，由 onError 槽接；或返回 done:true 终止整轮
```

- `input`：进入本节点的输入（来自上一节点 `output`，或引擎按 `ctx` 推导）。
- `ctx`：跨节点可变状态（见 §5）。
- 返回 `next` 可覆盖 `registry.json` 的 `next`（节点自身也能改走向）；返回 `done:true`
  等价于现有循环的 break，整轮结束。

## 4. 默认线性编排（node-graph 引擎）

### 4.1 主干节点清单（10 个，`type: core`）

顺序即默认 `next`：

| # | id | 职责 | 对应现有 chat() 阶段 |
|---|----|------|----------------------|
| 1 | `resolve-input` | 取最后一条 user、解析 references / workspace | `pendingUser` / `_resolveReferences` |
| 2 | `resolve-model` | provider / baseUrl / apiKey / model / effort | `resolveProvider` / effort 映射 |
| 3 | `assemble-system` | 首轮装配 system prompt | `assembleSystemPrompt` |
| 4 | `build-context` | 拼 surface + refs + user 成请求消息；plan-mode 拼 POLICY | `_requestMessages` |
| 5 | `auto-compact` | pre-step 压力压缩（失败只告警） | `_maybeCompactStep` |
| 6 | `model-request` | 一次模型请求（stream / tool_calls 解析） | `_stream` |
| 7 | `tool-approve` | 逐 tool_call 走权限门 ask/deny | `requestApproval` |
| 8 | `tool-run` | 链路薄透传（实际执行已统一在 tool-approve 内，见 §4.3） | — |
| 9 | `plan-review` | exit_plan_mode 触发时挂起等审批 | `requestPlanReview` |
| 10 | `decide-next` | 还有 tool_calls？`next: model-request`（构成 step 循环）；否则 `done:true` | 现有 `for(;;r++)` 终止判定 |

step 循环 = `decide-next` 返回 `{ next: 'auto-compact' }`（无步数上限，与现有一致）。
说明：`auto-compact` 在每个 step 请求前都执行（对应 linear 主循环内 `for(;;r++)` 每轮都跑
`_maybeCompactStep`），因此 step 循环回到 `auto-compact` 而非 `model-request`，保证自动压缩
覆盖每一次模型请求（首轮亦包含）。文档 §4.1 表中 `decide-next` 的「next: model-request」属
简写，实际落地以本段为准。

### 4.3 节点细化说明（落地修订）

- **`tool-approve` 统一执行**：linear 主循环对每个 tool-call 是「校验 → 授权 → 立即执行 →
  推结果」顺序交织（见 `core/loops/linear.js`），保证 `tool_call` / `approval-request` /
  `tool_result` 事件按调用顺序逐条产出。为保持 node-graph 与 linear 事件流完全一致，本引擎
  把「授权 + 执行」统一在 `tool-approve` 内完成；`tool-run` 节点作为链路上的薄透传
  （`next: plan-review`），维持 §4.1 的 10 节点拓扑而不破坏事件顺序。
- **`plan-review` 薄透传**：linear 中 `exit_plan_mode` 触发的计划审批是由 plan-mode 工具在
  执行期间通过 `core.requestPlanReview` 回调挂起等待用户批准的（非独立顺序阶段），因此本节点
  不单独处理审批，只把控制流转给 `decide-next`。
- **输出翻译仅由 hook 注入**：`decide-next` 不再做输出翻译；最终回答的英→中翻译由挂在
  `model-request.after` 的 `builtin.translate-output` hook 完成（见 §7）。该 hook 仅在
  `finish_reason !== "length"` 且无 tool_calls 时翻译，避免对截断/工具响应误翻译。

### 4.2 二级预定义节点（2 个，`type: builtin`）

| id | 职责 | `next` 指向 |
|----|------|-------------|
| `builtin.translate-input` | 中文→英文（失败阻断整轮） | `resolve-input`（回归主干继续点） |
| `builtin.translate-output` | 英文→中文（仅最终回答） | `model-request` |

它们**不是**默认 `next` 链的一员；只在 hook 被注册（且 `settings.translate.enabled`）
时才被调用。详见 §7。

## 5. ctx 契约

引擎每跑一次 `node-graph.runLoop` 维护一个 `ctx` 对象，跨节点可变传递。

- 起点：`chat()` 把入参与 core 句柄塞进 `ctx` 作为初始值：
  - 入参：`ctx.messages` / `ctx.model` / `ctx.onEvent` / `ctx.sessionId` /
    `ctx.stream` / `ctx.autonomy` / `ctx.activity` / `ctx.references` / `ctx.effort`
  - core 句柄：`ctx.store` / `ctx.tools` / `ctx.permissions` / `ctx.fsPolicy` /
    `ctx.planMode` / `ctx.translateCfg`（来自 `readSettings()`）
- 节点 `run(input, ctx)` 读写 `ctx`。现有 `chat()` 局部变量映射：
  - `conv` → `ctx.conv`
  - `effModel` → `ctx.model`
  - `system` → `ctx.system`
  - `translatedUser` → `ctx.translatedUser`
  - `toolDefs` → `ctx.toolDefs`
  - `turn` / `step` → `ctx.turn` / `ctx.currentStep`
- 第一个节点 `resolve-input` 的 `input` 取 `ctx.messages`。

## 6. Hook 协议

### 6.1 注册 API（仅普通 hook）

```js
engine.registerHook(nodeId, slot, fn)
// fn(input, ctx) => instruction
```

- `slot` ∈ `before` | `after` | `onError`。
- **只用普通 hook**，不引入"节点式 hook"概念。hook 是挂在节点槽上的回调（编排胶水）；
  节点是流程单元。二级预定义节点通过普通 hook 内部调用（见 §7）。
- 同槽多个 hook **顺序执行成管道**：按注册顺序（或显式 `priority`，默认 0，越大越先）。
  前一个 `modify` 改后的 `input` 传给下一个；`short-circuit`/`goto` 立即终止本槽链。

### 6.2 指令协议（hook 与节点 run 共用）

```js
{ action: "continue" }                                  // 正常继续
{ action: "modify", input }                              // 替换传给节点的输入
{ action: "short-circuit", output? }                     // 跳过本节点，直接出结果
{ action: "goto", next: "<nodeId>" }                     // 改变流程走向，跳到指定节点
```

- `onError` 槽也返回同款协议：默认（无 onError 或 `continue`）错误向上抛，由 loop 全局
  try 统一记 `[turn]` 日志并终止（沿用 `TurnError`）；`short-circuit` 可用兜底值替代、
  `goto` 可跳到错误处理节点。

### 6.3 调度器（内置）

- 引擎维护"当前节点"指针，跑完一个节点读其 `next`（或被 hook/goto 覆盖），跳下一个。
- `goto` 目标必须是节点表里存在的 id；`builtin` 节点 id 同样合法（执行完按其 `next`
  回归主干）。
- control-flow（goto / step 循环 / 终止）由调度器统一解释，节点与 hook 只产出指令，
  不构成语法特例。

## 7. translate 作为 hook 注入

对应需求"translate 以 hooks 注入的方式在 node-graph 中实现"。

- `core/loops/builtins/translate.js` 导出 `translateInputNode` / `translateOutputNode`
  （完整 Node，有 `run()`，`type: builtin`）。
- 挂载用**普通 hook**：

```js
// 仅当 settings.translate.enabled 时注册
if (translateCfg.enabled) {
  engine.registerHook('resolve-input', 'before', async (input, ctx) => {
    const out = await loadNode('builtin.translate-input').run(input, ctx);
    return { action: 'modify', input: out.output };
  });
  engine.registerHook('model-request', 'after', async (input, ctx) => {
    const out = await loadNode('builtin.translate-output').run(input, ctx);
    return { action: 'modify', input: out.output };
  });
}
```

- 关闭时完全不注册 → 主干不含翻译，模型直接看中文/原文。translate 因此成为"可插拔、
  非主干"的能力，与 §4.2 的 `builtin` 语义一致。

## 8. 迁移与落地步骤

1. **先抽 `linear` 引擎（最小搬家，行为零改动）**：把 `core/index.js` 的 `chat()` 主循环
   体搬进 `core/loops/linear.js` 的 `runLoop(ctx)`；`chat()` 改为参数归一 + 选引擎 +
   转发。现有测试/行为不变。此步验证注册表机制可用。**（已完成）**
2. **建节点注册表** `core/loops/registry.js` 的 `loadNodes()`：扫描 `nodes/*/registry.json`
   返回 `Map<nodeId, Node>`（Node = registry 字段 + 从 `entry` 加载的 `run`）。**（已完成）**
3. **写 `node-graph.js`**：调度器 + §4 的 10 个主干节点目录（`run()` 薄壳，复用现有
   core 方法，不重写）+ `builtins/translate.js`。**（已完成）**
4. **接线 translate hook**：`settings.translate.enabled` 控制是否注册 §7 的两个普通 hook。
   **（已完成）**
5. **双引擎对照测试**（见 §9）。**（已完成：`test/loop-node-graph.test.js`，8 用例全过；
   全量 `npm test` 69/71 通过，剩余 2 个为既有的 stale plan-mode 用例，与本次改动无关）**

## 9. 测试策略

- 现有 `test/tools.test.js` 等继续覆盖 `linear`。
- 新增 `test/loop-node-graph.test.js`：用同一组输入分别跑 `linear` 与 `node-graph`
  （设置 `AGENT_LOOP_ENGINE=node-graph`），断言两者产出的消息序列 / 事件流一致，重点覆盖：
  - tool-call 的 step 循环（多次 model 请求直到无 tool_calls）
  - `settings.translate.enabled` 开/关对输出的影响
  - plan-mode（`exit_plan_mode` 审批通过/拒绝）
  - 自动压缩触发
- 目标：证明 `node-graph` 不是"另一个实现"，而是"同一能力的另一种调度"。

## 10. 开放项 / 后续

- `settings.loopGraph` 是否支持浅合并覆盖默认编排（实验性重排），本稿默认"编排隐式定义
  在节点 `next` 中"，不另设编排常量表；若需运行时改编排再引入。
- `builtin` 节点的 `next` 回归点如有歧义，以 registry.json 声明的 `next` 为准。
- `linear` 引擎是否未来也受益于节点化，不在本稿范围（保持传统函数实现）。
