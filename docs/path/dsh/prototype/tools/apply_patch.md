# `apply_patch`

## name

`apply_patch`

## description

模型收到的工具说明原文：

```text
Create, update, delete, or move UTF-8 text files with one patch; prefer it over multiple edit calls when a change spans several files or separated regions.
```

## system-section

- 段落名：`tool:apply_patch`
- 序号（section order）：`TOOL_APPLY_PATCH`（1350）
- 注册位置：`packages/fs/tool-fs/src/apply-patch.ts:18`
- 非空条件：本作用域可见 `apply_patch` 时非空

原文：

```text
Prefer apply_patch over separate edit calls for changes across files or separated regions. Give every hunk enough surrounding context lines to match one place in the current file. The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing; once applying starts, operations run in order, stop at the first failure, and are not rolled back, so re-read affected files before retrying when needed.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "description": "Patch text: start with *** Begin Patch and end with *** End Patch. Use *** Add File: path with + lines; *** Update File: path, optionally followed by *** Move to: path, with @@ or @@ context and space-prefixed context, + added, or - removed lines; *** End of File anchors the last hunk to the file end. Use *** Delete File: path to delete. Paths are relative to the Session working directory."
    }
  },
  "required": [
    "input"
  ]
}
```

## result-format

返回逐文件的操作结果（新增/更新/删除/移动）；`presentResult` 把补丁操作渲染成补丁卡片。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `tool-fs` 的 `applyPatch` 配置为真时注册；`base` 与 Web `standard` 预设开启，`ptc`、`cordis` 预设与 PTC overlay 关闭。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `edit` 可见 | 无变化；`apply_patch` 段落自身建议“跨文件或分散区域改动时优先用它”，与 `edit` 并存不产生冲突 |
| `apply_patch` 未注册（`applyPatch: false`） | 段落按可见性为空串，不进入系统提示词 |
| 执行器换成 PTC | `tool:apply_patch` 段落整体失效，改用 `tools:sdk` |

### 展示投影

`presentResult` 依据持久化的补丁操作记录重建补丁卡片。

## 来源

- 包：`@deepseek-ai/dsh-tool-fs`（`reference/deepseek-harness/packages/fs/tool-fs`）
