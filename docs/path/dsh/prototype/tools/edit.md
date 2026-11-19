# `edit`

## name

`edit`

## description

模型收到的工具说明原文：

```text
Edit an existing UTF-8 text file by replacing literal text.
```

## system-section

- 段落名：`tool:edit`
- 序号（section order）：`TOOL_EDIT`（1300）
- 注册位置：`packages/fs/tool-fs/src/edit.ts:77`
- 非空条件：本作用域可见 `edit` 时非空

原文：

```text
Read a file before editing it unless you just created or edited it in this session.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments."
    },
    "old_string": {
      "type": "string",
      "description": "Literal text to replace."
    },
    "new_string": {
      "type": "string",
      "description": "Literal replacement text. Use an empty string to delete the match."
    },
    "replace_all": {
      "type": "boolean",
      "description": "Replace all matches. Defaults to false; when false, old_string must appear exactly once."
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string"
  ]
}
```

## result-format

返回编辑结果（替换次数、改动范围等）；`presentResult` 用 `meta.diffs` 生成 `Edit <path>` 的 diff 卡片，缺失 diff 时不渲染卡片。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂。
- 读前约束由 `fs-observation-policy` 决定。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `read` 可见 | 无变化；`edit` 段落不依赖 `read`，但读前写观察策略由 `fs-observation-policy` 决定 |
| `apply_patch` 可见 | 无变化；两者同时存在时 `apply_patch` 建议跨文件改动优先用它 |
| 执行器换成 PTC | `tool:edit` 段落整体失效，改用 `tools:sdk` |

### 展示投影

`presentResult` 用 `meta.diffs` 生成 diff 卡片；没有 diffs 时退回文本视图。

## 来源

- 包：`@deepseek-ai/dsh-tool-fs`（`reference/deepseek-harness/packages/fs/tool-fs`）
