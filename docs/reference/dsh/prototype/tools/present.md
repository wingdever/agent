# `present`

## name

`present`

## description

模型收到的工具说明原文：

```text
Declare existing files as final deliverables for the user. Hosts may show presented files only after your turn ends, so call it once the files are final. If the user needs to review files earlier, such as before a tool call that waits for their answer, link them in your message instead. Use it when the user needs a separate file, especially Office documents, spreadsheets, and slide decks; prefer your final response when that suffices. The user opens the current files; their contents are not copied.
```

## system-section

不贡献独立段落；交付文件引用规范由 `ui:deliverable-file-references`（9000）提供，见 communicate-contract.md 3.29。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "description": "Usually the 1-2 most important deliverables; at most 4 per call.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "description": "Path of an existing regular file. Relative paths use the Session working directory."
          },
          "description": {
            "type": "string",
            "description": "Brief description for the user."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  "required": [
    "files"
  ]
}
```

## result-format

返回交付确认；`deliverables/presented` 事件记录到会话，供宿主展示文件卡片。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- Web / SDK 桌面组合挂载该工具；交付归属调用方会话。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| Web / SDK 桌面组合 | `ui:deliverable-file-references` 段落同时出现，指引模型在最终回答里给出文件引用 |
| 非桌面组合 | `present` 不注册，段落也不出现 |

## 来源

- 包：`@deepseek-ai/dsh-tool-present`（`reference/deepseek-harness/packages/deliverables/tool-present`）
