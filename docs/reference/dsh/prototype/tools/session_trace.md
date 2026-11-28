# `session_trace`

## name

`session_trace`

## description

模型收到的工具说明原文：

```text
Read the authorized session lineage around one session, including complete visible ancestor and descendant relationships.
```

## system-section

本段落与同组工具共用，由同一个注册点提供：

- 段落名：`tool:session-query`
- 序号（section order）：`TOOL_SESSION_QUERY`（2300）
- 注册位置：`packages/experimental/tool-session-query/src/index.ts:59`
- 非空条件、原文与变体：同组工具共用同一段文本，逐字模板见 [`session_search`](session_search.md) 的 system-section；文本本身不再在本页重复。


## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    }
  }
}
```

## result-format

返回事件、事件链或轨迹数据；超出内联上限时完整结果写入 spill 文件。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 同 `session_search`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `session-query` 后端开启 | 五个工具披露，共用段落 |
| 后端关闭 | 不披露 |

## 来源

- 包：`@deepseek-ai/dsh-tool-session-query`（`reference/deepseek-harness/packages/experimental/tool-session-query`）
