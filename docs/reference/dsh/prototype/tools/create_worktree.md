# `create_worktree`

## name

`create_worktree`

## description

模型收到的工具说明原文：

```text
Create a new Git branch and worktree from a local commit, branch, or tag, then change this session's working directory to it. Uncommitted files stay in the source checkout. Existing names fail. Use working_directory with cd to leave; the checkout and branch remain.
```

## system-section

`@deepseek-ai/dsh-experimental-tool-worktree` 不注册系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "New branch name, also used as the checkout directory: a few lowercase words joined by hyphens that describe the task, such as fix-login-retry. Omit to generate a unique name."
    },
    "from": {
      "type": "string",
      "description": "Local commit, branch, or tag to start from. Defaults to HEAD; no fetch is performed."
    }
  }
}
```

## result-format

返回新工作树路径与分支。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 实验工具，仅在挂载该插件的组合中出现。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 与 `create_worktree` 同组的实验能力 | 按实验包组合出现，不改变 shipped 组合的段落 |
| shipped 组合 | 不出现 |

## 来源

- 包：`@deepseek-ai/dsh-experimental-tool-worktree`（`reference/deepseek-harness/packages/experimental/tool-worktree`）
