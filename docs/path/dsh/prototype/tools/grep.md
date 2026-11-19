# `grep`

## name

`grep`

## description

模型收到的工具说明原文：

```text
Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns up to 250 matches; a larger result reports where the complete match list was saved.
```

## system-section

- 段落名：`tool:grep`
- 序号（section order）：`TOOL_GREP`（1500）
- 注册位置：`packages/fs/tool-fs-search/src/grep.ts:277`
- 非空条件：本作用域可见 `grep` 时非空

原文：

```text
Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.
（`read` 不可见时省略后半句）
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Regular expression to search for (ripgrep syntax)."
    },
    "path": {
      "type": "string",
      "description": "File or directory to search. Defaults to the session workspace; a relative path resolves against it."
    },
    "include": {
      "type": "string",
      "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
    }
  },
  "required": [
    "pattern"
  ]
}
```

## result-format

返回规范化值 `{ matches[] }`，每条含路径、行号与匹配行预览。内联页最多 `maxMatches`（默认 250）条；超出时 spill 文件保存**完整**结果（每行保留预览），结果末尾附同样的去向提示。`presentResult` 渲染匹配列表卡片。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂；ripgrep 通过 `ctx.subprocess` 以普通前台进程执行，从不进入后台任务。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `read` 可见 | 段落完整：`Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.` |
| `read` 不可见 | 省略后半句，只剩 `Use the grep tool — not shell grep or rg — to search file contents.` |
| `glob` 可见 | 无变化；两者各自贡献一段 |
| 执行器换成 PTC | `tool:grep` 段落整体失效，改用 `tools:sdk` |

### 展示投影

`presentResult` 渲染按文件分组的匹配列表卡片。

## 来源

- 包：`@deepseek-ai/dsh-tool-fs-search`（`reference/deepseek-harness/packages/fs/tool-fs-search`）
