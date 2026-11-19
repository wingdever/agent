# `ralph`

## name

`ralph`

## description

模型收到的工具说明原文：

```text
Run a foreground fresh-agent Ralph loop toward one immutable objective. Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Each round opens a new child with no parent conversation or prior child session; the shared workspace is long-term memory, and only a bounded structured report crosses rounds. The call returns when a worker reports completion or a concrete blocker, or at the round limit. Ordinary long-running same-session work belongs to goal tools.
```

## system-section

- 段落名：`tool:ralph`
- 序号（section order）：`TOOL_RALPH`（2700）
- 注册位置：`packages/experimental/tool-ralph/src/index.ts:413`
- 非空条件：注册了 `ralph` 工具即贡献

原文：

```text
Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The immutable completion objective for every fresh Ralph round."
    },
    "maxRounds": {
      "type": "number",
      "description": "Optional positive safe-integer round cap, bounded by the deployment ceiling."
    }
  },
  "required": [
    "objective"
  ]
}
```

## result-format

返回各轮 worker 报告汇总；完成与阻塞均为 worker 自述。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 实验工具；shipped 组合不挂载。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 组合挂载 ralph | 段落 `tool:ralph` 出现 |
| 组合未挂载 | 工具与段落都不出现 |

## 来源

- 包：`@deepseek-ai/dsh-tool-ralph`（`reference/deepseek-harness/packages/experimental/tool-ralph`）
