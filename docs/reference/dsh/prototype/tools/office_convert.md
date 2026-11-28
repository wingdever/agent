# `office_convert`

## name

`office_convert`

## description

模型收到的工具说明原文：

```text
Convert a document to another format. Return a temporary file to copy to its destination with the shell.
```

## system-section

`@deepseek-ai/dsh-tool-office` 的三件套不注册系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "description": "Path to doc, docx, odt, xls, xlsx, ods, ppt, pptx, or odp; not modified."
    },
    "format": {
      "type": "string",
      "description": "Word: pdf, docx, odt, txt. Excel: pdf, xlsx, ods, csv. PowerPoint: pdf, pptx, odp.",
      "enum": [
        "pdf",
        "docx",
        "odt",
        "txt",
        "xlsx",
        "ods",
        "csv",
        "pptx",
        "odp"
      ]
    },
    "sheet": {
      "type": "string",
      "description": "Exact worksheet name for CSV only; required when the workbook has several sheets."
    }
  },
  "required": [
    "input",
    "format"
  ]
}
```

## result-format

返回转换结果或渲染出的图片附件；未安装 LibreOffice Kit 时返回不可用错误。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 该 agent 成功加载 Office 技能后的下一步起披露；只要上一请求头仍声明 Office 工具就保持可见。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 该 agent 已加载 Office 技能 | 三件套在下一步起披露；只要上一请求头仍声明 Office 工具就保持可见 |
| 未加载 Office 技能 | 三件套不披露，模型看不到 |
| PTC 模式下失去内存标记 | 需重新加载一次 Office 技能才能再次披露 |

## 来源

- 包：`@deepseek-ai/dsh-tool-office`（`reference/deepseek-harness/packages/document/tool-office`）
