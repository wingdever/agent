# `write`

## name

`write`

## description

模型收到的工具说明原文：

```text
Create or fully replace a UTF-8 text file.
```

## system-section

- 段落名：`tool:write`
- 序号（section order）：`TOOL_WRITE`（1200）
- 注册位置：`packages/fs/tool-fs/src/write.ts:63`
- 非空条件：本作用域可见 `write` 时非空

原文：

```text
Read an existing file before overwriting it with write and prefer edit for targeted changes.
（`edit` 不可见时后半句省略，得到 `Read an existing file before overwriting it with write.`）
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to write, resolved by the filesystem backend. Provide `file_path` before `content` in the arguments."
    },
    "content": {
      "type": "string",
      "description": "Full UTF-8 text content to write."
    }
  },
  "required": [
    "file_path",
    "content"
  ]
}
```

## result-format

返回写入结果值（文件路径与写入字节/行数等）；`presentResult` 用 `meta.diffs` 或 `args.content` 生成 diff 卡片 `Write <path>`。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂。
- 读前写观察由 `fs-observation-policy` 决定。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `edit` 可见 | 段落完整：`Read an existing file before overwriting it with write and prefer edit for targeted changes.` |
| `edit` 不可见 | 省略后半句，只剩 `Read an existing file before overwriting it with write.` |
| `apply_patch` 可见 | 无变化；`write` 不引用 `apply_patch`，但 `apply_patch` 的段落建议跨文件改动优先用它 |
| 执行器换成 PTC | `tool:write` 段落整体失效，模型改从 `tools:sdk` 声明里找到 `write` 方法（见 communicate-contract.md 的执行器模式一节） |

### 展示投影

`presentResult` 用 `meta.diffs` 生成 diff 卡片，缺 `meta.diffs` 时按 `args.content` 构造「整文件新增」的 diff。

## 来源

- 包：`@deepseek-ai/dsh-tool-fs`（`reference/deepseek-harness/packages/fs/tool-fs`）
