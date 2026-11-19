# `list_mcp_resource_templates`

## name

`list_mcp_resource_templates`

## description

模型收到的工具说明原文：

```text
List parameterized resource URI templates from an MCP server.
```

## system-section

不贡献 `tool:*` 段落；注册了 MCP 资源工具且存在服务器时，`mcp-resource-servers`（3100）非空：

```text
## MCP resource servers

Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: [<names>]。
```

该段落在 `interpolate: false` 下渲染，服务器名升序。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "Configured MCP server name."
    },
    "cursor": {
      "type": "string",
      "description": "Continuation cursor returned by this server."
    }
  },
  "required": [
    "server"
  ]
}
```

## result-format

返回 MCP 资源列举参数化资源 URI 模板结果；失败以 `Error:` 文本返回。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配 `mcp-resources` 且至少一个 MCP server 暴露资源能力时注册。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 有 MCP server 提供资源 | `mcp-resource-servers` 段落出现，三个资源工具可用 |
| 没有资源型 server | 段落为空，工具不披露 |

## 来源

- 包：`@deepseek-ai/dsh-mcp-resources`（`reference/deepseek-harness/packages/mcp/mcp-resources`）
