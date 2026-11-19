# `list_subagent_models`

## name

`list_subagent_models`

## description

模型收到的工具说明原文：

```text
Inspect the routes available for explicit subagent model selection. No arguments: authorized providers. `provider`: that provider's authorized models. `provider` + `model`: that model and its reasoning efforts. Query when choosing an explicit child route or reasoning effort. Omit optional fields rather than sending empty strings.
```

## system-section

不贡献系统提示词段落；可用模型列表来自 `list_models` 型的子代理模型发现能力。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "description": "Registered LLM provider id."
    },
    "model": {
      "type": "string",
      "description": "Exact model id; requires provider."
    }
  }
}
```

## result-format

返回可选 provider / model / reasoning effort 组合。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `subagent` 的 `modelDiscovery` 开启时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `subagent` 的 `modelDiscovery` 关闭 | 不注册，模型看不到这个工具 |
| `subagent` 与 `subagent_fork` 同时可见 | 段落由排第一的委派工具贡献，本工具不分段 |

## 来源

- 包：`@deepseek-ai/dsh-tool-subagent`（`reference/deepseek-harness/packages/subagent/tool-subagent`）
