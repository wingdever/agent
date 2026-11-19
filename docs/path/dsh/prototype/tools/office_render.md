# `office_render`

## name

`office_render`

## description

模型收到的工具说明原文：

```text
Render document pages, slides, or worksheet areas as images you can view.
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
      "description": "Path to doc, docx, odt, xls, xlsx, ods, ppt, pptx, odp, or pdf; not modified."
    },
    "pages": {
      "type": "array",
      "description": "Distinct one-based pages or slides; omit for all. Spreadsheets use sheet and range instead.",
      "items": {
        "type": "integer"
      }
    },
    "sheet": {
      "type": "string",
      "description": "Exact worksheet name; omit to render every visible sheet."
    },
    "range": {
      "type": "string",
      "description": "A1 range, such as A1:H40; requires sheet. Omit for the used area."
    },
    "dpi": {
      "type": "integer",
      "description": "Resolution from 24 to 600; default 144."
    }
  },
  "required": [
    "input"
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
