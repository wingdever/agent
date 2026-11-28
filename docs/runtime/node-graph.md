# 节点化 Agent-Loop 引擎（node-graph）

node-graph 是默认 agent-loop 引擎，由 `AGENT_LOOP_ENGINE` 选择，不设该变量时即走此引擎。它与冻结对照引擎 linear 并存，两者共用同一批 core 服务，只差调度方式：linear 是函数式 for 循环，node-graph 是节点 `next` 链调度。

## 1. 组成

```
core/loops/
  index.js          引擎注册表 + getLoop(name)
  node-graph.js     调度器：hook、节点执行、终止收尾与 [turn] 日志
  registry.js       loadNodes()：扫描 nodes/* 与 builtins/*
  loops-config.js   agent/loops.json 的 hook overlay
  nodes/*/          主干节点（registry.json + run.js）
  builtins/*/       二级节点，不在默认 next 链上，仅由 hook 调用
```

每个节点目录含 `registry.json`（`id` / `next` / `type` / `hooks` / `entry`）与 `run.js`。`run.js` 导出 `async (input, ctx) => { output, next?, done? }`；`loadNodes()` 返回 `Map<nodeId, Node>`。

## 2. 主干节点与 next 链

| # | id | 职责 | next |
|---|---|---|---|
| 1 | `turn-start` | turn 初始化：会话门、工具选择与权限/路径策略、todo 重置、翻译配置、建 turn 行 | `resolve-target` |
| 2 | `resolve-target` | 解析 provider / model / baseUrl / apiKey / effort / stream | `assemble-system` |
| 3 | `assemble-system` | 首轮装配 system prompt 与 skill 目录消息，后续轮复用已存文本 | `assemble-input` |
| 4 | `assemble-input` | 校验最后一条 user、解析 @引用、投影请求历史（含 runtime-context） | `pre-step` |
| 5 | `pre-step` | plan 退出生效、记录请求头上的 plan 态、压力压缩 | `model-call` |
| 6 | `model-call` | 建 step、落首步消息、发起模型请求（overflow 重试一次）、落 assistant/call、记 token anchor | `tool-execute` |
| 7 | `tool-execute` | 逐 tool_call 校验、授权、执行、落 tool 结果与 call 回写 | `decide-next` |
| 8 | `decide-next` | 截断/空回复判错；无 tool_calls 时收尾；有 tool_calls 时回到 `pre-step` | `pre-step` / done |

前四个节点每个 turn 各跑一次；**后四个节点构成 step 循环**：`pre-step → model-call → tool-execute → decide-next → pre-step`，直到 `decide-next` 判定无工具调用。步数不设上限，是否继续由模型决定。

## 3. 调度器

`runLoop(core, ctx)` 构造跨节点上下文，从 `turn-start` 进入 `_dispatch`：

- `_dispatch`：跑当前节点 → `done` 则结束 → 取 `result.next || node.next` → 用 `result.output` 作为下一次 input 继续。
- `_runNode`：按 `before → node.run → after` 执行；`onError` 只在 `node.run` 抛错时接。节点返回 `output` / `next` / `done`，hook 返回下列指令，由调度器统一解释。

| action | 含义 |
|---|---|
| `continue` | 正常继续 |
| `modify` | 替换传给下一环节的输入 |
| `short-circuit` | 跳过本节点，直接以给定 output 结束整轮 |
| `goto` | 跳到指定节点 id；builtin 节点同样合法，执行完按其 `next` 回归主干 |

`goto` 目标必须在节点表中存在，否则记 turn 失败。

## 4. Hook 与 translate

`registerHook(nodeId, slot, fn)` 把回调挂到节点的 `before` / `after` / `onError` 槽；同槽多个按注册顺序成管道执行。`agent/loops.json` 的扁平数组在引擎启动时装配成 hook（`loops-config.js`）：

| on | slot | target |
|---|---|---|
| `assemble-input` | before | `builtin.translate-input` |
| `model-call` | after | `builtin.translate-output` |

builtin 节点有完整的 `run()` 与 `next`，但不在默认 next 链上，只由 hook 调用。关闭翻译即不注册 hook，主干不含翻译阶段。输出翻译只发事件、不改落库文本；输入翻译写入请求历史后落库。

## 5. turn 与 step 生命周期

- `turn-start`：建 turn 行（running）并占用当前会话，阻止并发压缩。
- `model-call`：每次请求建一条 step 行（running），递增 step 序号；r>0 发 `step-start`；首步另落 system / 目录 / 用户输入。
- `tool-execute`：工具批次结束后把当前 step 标 succeeded。
- `decide-next`：正常收尾发 `done`，把 step 与 turn 标 succeeded；有工具调用则回到 `pre-step`。
- 异常统一由 `runLoop` 的 catch 标记当前 step 与 turn 为 failed，以 `TurnError.reason` 区分终止原因。
- turn 结束打一行 `[turn] session=… turn=… status=… reason=… steps=… tools=… duration=…ms`，并发 `turn-end` 事件；失败轮次不发 `done`。

## 6. 测试

`test/loop-node-graph.test.js` 用同一组输入分别跑 linear 与 node-graph，断言消息序列与事件流一致，覆盖工具调用的 step 循环、翻译开/关、plan-mode、自动压缩。目标是证明 node-graph 是同一能力的另一种调度，不是另一套实现。
