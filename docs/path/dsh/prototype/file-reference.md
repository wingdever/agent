# file-reference（功能）

`@` 文件引用规范：告诉模型"以 @ 开头的 token 是什么"。它**贡献一个受工具可见性驱动的 section**，规则部分见 `system-prompt.md`。

## 1 它在什么时候出现

- `file-reference-local` 插件挂载，且本 agent 可见 `read` 工具时非空。
- 没有 `read` 时整段为空串，`@` 引用规范完全消失。

## 2 它注入什么

`context:file-reference`（`FILE_REFERENCE`，900）：

```text
Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.
```

## 3 它如何配合规则

- **排序**：`FILE_REFERENCE`（900），位于计划态与 Team 策略之后、工具指引之前。
- **动态性**：段落函数查询 `read` 是否可见，结论随工具限制与激活谓词变化。
- **与引用注入的配合**：本段只说明规范；真正被引用的内容由 `@` 引用解析以 user 消息注入，见 `communicate-contract.md` 的消息通道。

## 4 组合条件

- 这是"有状态组合包"之一：段落有无取决于 `read` 是否同处，见 `tools/README.md`。
- base 组合不挂载 `file-reference-local`，本段缺席。
