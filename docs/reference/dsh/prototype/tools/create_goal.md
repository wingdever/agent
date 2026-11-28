# `create_goal`

## name

`create_goal`

## description

模型收到的工具说明原文：

```text
Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.
```

## system-section

- 段落名：`tool:goal`
- 序号（section order）：`TOOL_GOAL`（2400）
- 注册位置：`packages/goal/tool-goal/src/index.ts:189`
- 非空条件：注册了任意 goal 工具即贡献；三个工具共用同一段落

原文：

```text
create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least <blockedAfter> consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The concrete completion objective inferred from the direct human request."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Optional positive safe-integer limit on automatic continuation rounds."
    }
  },
  "required": [
    "objective"
  ]
}
```

## result-format

返回目标对象（id、revision、状态等）或校验失败信息。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂（`tool-goal`），依赖 `ctx.goals`。
- create 要求直接人类来源的 root 权限；`blockedAfterConsecutiveRounds` 默认 3。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 三个 goal 工具同时挂载 | 共用一个段落 `tool:goal`，只贡献一次 |
| 只挂载其中一个 | 仍贡献同一个段落，文本不变 |
| `blockedAfterConsecutiveRounds` 改动 | 段落中的 `at least <blockedAfter> consecutive goal rounds` 数字随之改变 |
| 执行器换成 PTC | `tool:goal` 段落失效，改用 `tools:sdk` |

## 来源

- 包：`@deepseek-ai/dsh-tool-goal`（`reference/deepseek-harness/packages/goal/tool-goal`）
