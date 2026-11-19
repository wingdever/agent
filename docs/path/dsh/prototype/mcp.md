# MCP（功能）

MCP server 的模型可见信息：每个 server 可自带 instructions，资源型 server 还能被列举。它是**内容由外部提供**的功能，规则部分见 `system-prompt.md`。

## 1 它在什么时候出现

- 随连接加载注册：每个提供 instructions 的 server 贡献一段 `mcp:<server>`，正文是该 server 的 instructions 原文。
- 连接断开或重新同步时段落内容随之变化；server 的指令为空时段落为空。
- 资源型 server 被列举时，`mcp-resource-servers` 按已注册 server 名动态生成。

## 2 它注入什么

每个提供 instructions 的 MCP server 一段，段名 `mcp:<server>`，正文为该 server 的 instructions 原文（`interpolate: false`）。

资源服务器汇总（`mcp-resource-servers`），`<names>` 为升序 server 名数组：

```text
Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: [<names>].
```

## 3 它如何配合规则

- **排序**：都取 `MCP_SERVERS`（3100），在工具指引之后、SDK 声明之前；多个 server 的段落同序，按名字码元序排列。
- **不插值**：两份内容都 `interpolate: false`，server 名称里的花括号不会被当成变量。
- **与工具的关系**：MCP 工具本身以 `mcp__<server>__<raw>` 进入工具声明，规则见 `tools/README.md`；本段只承载 instructions 与资源清单。

## 4 组合条件

- 没有 MCP server 时两段都不出现。
- server 同时提供 tools 与 resources 时，工具声明与两段文本同时存在，互不影响。
