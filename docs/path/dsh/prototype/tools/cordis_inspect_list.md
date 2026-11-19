# `cordis_inspect_list`

## name

`cordis_inspect_list`

## description

模型收到的工具说明原文：

```text
List every Cordis Inspect Provider currently known to the Host, including local Host Providers and the latest manifests synchronized from the Client. Each entry includes its platform, purpose, read-only methods, and input/output schemas. Call this Tool before writing or configuring a plugin, then select the provider and method for cordis_inspect_query from its result. Do not guess names or treat an Inspect method as a business Service that Plugin code can call.
```

## system-section

`@deepseek-ai/dsh-tool-cordis` 不注册系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {}
}
```

## result-format

返回运行时 Cordis 检查项的列表 JSON。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- Creator 模式提供只读运行时检查工具；需要 Cordis 宿主运行器。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 组合有 Cordis 宿主运行器 | 两个 cordis_inspect_* 工具披露 |
| 没有运行器 | 不披露 |

## 来源

- 包：`@deepseek-ai/dsh-tool-cordis`（`reference/deepseek-harness/packages/extensions/tool-cordis`）
