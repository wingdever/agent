# `office_recalculate`

## name

`office_recalculate`

## description

模型收到的工具说明原文：

```text
Recalculate spreadsheet formulas. Return a temporary workbook to copy to its destination with the shell.
```

## system-section

见 `office_convert`：Office 三件套不注册系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "description": "Path to an xls, xlsx, or ods workbook; not modified."
    },
    "format": {
      "type": "string",
      "description": "Output workbook format.",
      "enum": [
        "xlsx",
        "ods"
      ]
    }
  },
  "required": [
    "input",
    "format"
  ]
}
```

## result-format

返回计算结果或渲染图片；依赖 LibreOffice Kit。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 同 `office_convert`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 该 agent 已加载 Office 技能 | 三件套披露 |
| 未加载 Office 技能 | 不披露 |

## 来源

- 包：`@deepseek-ai/dsh-tool-office`（`reference/deepseek-harness/packages/document/tool-office`）
