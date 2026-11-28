# `glob`

## name

`glob`

## description

模型收到的工具说明原文：

```text
Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. Returns up to 100 paths in modification-time order; a larger result is sampled across top-level entries and reports where the complete list was saved.
```

## system-section

- 段落名：`tool:glob`
- 序号（section order）：`TOOL_GLOB`（1400）
- 注册位置：`packages/fs/tool-fs-search/src/glob.ts:312`
- 非空条件：本作用域可见 `glob` 时非空

原文：

```text
Use the glob tool — not shell find — to discover files by path pattern.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree; include a separator to anchor the depth."
    },
    "path": {
      "type": "string",
      "description": "Directory to search in. Defaults to the session workspace; a relative path resolves against it."
    }
  },
  "required": [
    "pattern"
  ]
}
```

## result-format

返回规范化值 `{ root, paths[] }`：按修改时间排序的路径。内联页最多 `maxResults`（默认 100）条；超出时 `tools/post-execute` 把完整列表写入 spill 文件，并在结果末尾追加 `(Omitted <n> bytes. Full formatted result stored at: <path>. Use read with offset/limit, or grep this path to search within it.)`。`presentResult` 渲染文件列表卡片。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂；通过 `ctx.subprocess` 调用打包的 ripgrep，不依赖宿主安装。
- `sampleOverCapGlobResults` 决定超出上限时采样还是取头部。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `grep` 可见 | 无变化；两者各自贡献一段 |
| 执行器换成 PTC | `tool:glob` 段落整体失效，改用 `tools:sdk` |

### 展示投影

`presentResult` 渲染按顶层目录分组、组内按修改时间排序的文件列表卡片。

## 来源

- 包：`@deepseek-ai/dsh-tool-fs-search`（`reference/deepseek-harness/packages/fs/tool-fs-search`）
