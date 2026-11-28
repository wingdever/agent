# `team_task_get`

## name

`team_task_get`

## description

模型收到的工具说明原文：

```text
Read the complete latest value of one shared task before changing or executing it.
```

## system-section

本段落与同组工具共用，由同一个注册点提供：

- 段落名：`team:policy`
- 序号（section order）：`TEAM_POLICY`（600）
- 注册位置：`packages/team/tool-agent-team/src/index.ts:112`
- 非空条件、原文与变体：同组工具共用同一段文本，逐字模板见 [`team_task_create`](team_task_create.md) 的 system-section；文本本身不再在本页重复。


## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Shared task id."
    }
  },
  "required": [
    "task_id"
  ]
}
```

## result-format

返回共享任务板视图；`update` 需携带当前 revision 做乐观并发。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 同 `team_task_create`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| Team 模式关闭 | 四个 Team 工具都不披露，段落为空 |
| Team 模式开启 | 与 `team_task_create` 共用段落与可见性 |

## 来源

- 包：`@deepseek-ai/dsh-tool-agent-team`（`reference/deepseek-harness/packages/team/tool-agent-team`）
