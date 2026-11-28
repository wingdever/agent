# `working_directory`

## name

`working_directory`

## description

模型收到的工具说明原文：

```text
Read the current working directory, or change it with cd. Relative paths use the current directory. Existing shells and running processes keep their own directories.
```

## system-section

不贡献段落；当前目录由运行时上下文 `working-directory:current`（order 100，required）提供，切换时另有通知消息。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "cd": {
      "type": "string",
      "description": "Existing directory to enter. Omit to read the current directory."
    }
  }
}
```

## result-format

返回当前绝对工作目录的文本；`cd` 成功后返回切换后的目录，同时写入一条 `working-directory/change` 事件并排队一条目录变更通知。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `base` 组合常挂；要求存在调用 agent。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 有调用 agent | 运行时上下文 `working-directory:current` 出现（required），切换时另有通知消息 |
| 无 agent | 上下文为空串，不进入快照 |

## 来源

- 包：`@deepseek-ai/dsh-tool-working-directory`（`reference/deepseek-harness/packages/session/tool-working-directory`）
