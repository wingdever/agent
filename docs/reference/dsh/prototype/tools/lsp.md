# `lsp`

## name

`lsp`

## description

模型收到的工具说明原文：

```text
Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.
```

## system-section

- 段落名：`tool:lsp`
- 序号（section order）：`TOOL_LSP`（2200）
- 注册位置：`packages/lsp/tool-lsp/src/index.ts:102`
- 非空条件：注册了 `lsp` 工具即贡献

原文：

```text
Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "description": "goToDefinition, findReferences, goToImplementation, or hover.",
      "enum": [
        "goToDefinition",
        "findReferences",
        "goToImplementation",
        "hover"
      ]
    },
    "file_path": {
      "type": "string",
      "description": "The source file to query, relative to the workspace or absolute."
    },
    "line": {
      "type": "number",
      "description": "One-based line of the cursor."
    },
    "character": {
      "type": "number",
      "description": "One-based UTF-16 column of the cursor."
    }
  },
  "required": [
    "operation",
    "file_path",
    "line",
    "character"
  ]
}
```

## result-format

返回位置列表或悬停文本；无提供者时返回结构化 `LSP_UNAVAILABLE` 错误。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 需要已注册的 LSP 提供者（如 `dsh-lsp-stdio`）；未注册时 schema 不变、执行失败。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 组合有 LSP 提供者 | 工具可调，返回位置或悬停结果 |
| 组合没有 LSP 提供者 | schema 不变，执行返回 `LSP_UNAVAILABLE` |

## 来源

- 包：`@deepseek-ai/dsh-tool-lsp`（`reference/deepseek-harness/packages/lsp/tool-lsp`）
