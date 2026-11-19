# `read`

## name

`read`

## description

模型收到的工具说明原文：

```text
Read a UTF-8 text file and return line-numbered content.
```

## system-section

- 段落名：`tool:read`
- 序号（section order）：`TOOL_READ`（1100）
- 注册位置：`packages/fs/tool-fs/src/read.ts:69`
- 非空条件：本作用域可见 `read` 时非空

原文：

```text
Use the read tool — not shell commands like cat, sed, head, or tail — to inspect text files. Use offset and limit to read a line range or continue a large file.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to read, resolved by the filesystem backend."
    },
    "offset": {
      "type": "number",
      "description": "1-based first line to return. Defaults to 1."
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of lines to return. Defaults to 2000."
    }
  },
  "required": [
    "file_path"
  ]
}
```

## result-format

文本信封，逐行前置行号并附页脚：

```text
<path><display path></path>
<type>file</type>
<content>
<line>: <text>
…

<footer>
</content>
```

页脚按情况三选一：`(Showing lines <a>-<b> of <n>. Use offset=<b+1> to continue.)`、`(Output capped. Showing lines <a>-<b>. Use offset=<b+1> to continue.)`、`(End of file - total <n> lines)`；空文件只有页脚。`presentResult` 从信封还原正文，供 UI 重建行号与语法高亮视图。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂。
- 与 `apply_patch` / `edit` / `write` 的读前写观察策略由 `fs-observation-policy` 决定（shipped 组合默认未启用，写操作无前置读取要求）。
- 图片读取另由 `read_image` 提供，本工具只处理文本。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `grep` 可见 | `grep` 段落会追加 `Use read on a matched file when you need surrounding context.`；`read` 自身段落不变 |
| `file-reference-local` 挂载 | `@` 引用规范段落（`context:file-reference`）要求 `read` 可见才出现；没有 `read` 时整段消失 |
| 执行器换成 PTC | `tool:read` 段落整体失效，改用 `tools:sdk` |

### 展示投影

`presentResult` 读取 `meta` 中的行号与语言提示，把 `<content>` 信封还原成带行号的代码视图；信封不匹配时回落到原始文本。

## 来源

- 包：`@deepseek-ai/dsh-tool-fs`（`reference/deepseek-harness/packages/fs/tool-fs`）
