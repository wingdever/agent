# MCP

## 范围

MCP 把外部 server 提供的工具与资源接入本项目的工具系统。协议层由官方 `@modelcontextprotocol/sdk` 承担（握手、分页、SSE、会话 id、结果校验）；本项目负责配置、连接生命周期与面向模型的适配。传输覆盖 stdio 与 streamable-http。server 的安装、身份、数据持久化与模型/嵌入选择由 server 提供方负责，本项目不下载、不初始化、不托管服务。

## 配置

配置位于 `user/mcp.json`。顶层 `servers` 是对象，键即 `serverName`。文件不存在、`servers` 缺失或为空时不注册任何 MCP 工具，模型侧没有任何变化。

```json
{
  "servers": {
    "reference_memory": {
      "command": "mcp-server-memory",
      "args": [],
      "env": {
        "MEMORY_FILE_PATH": "${PROJECT_ROOT}/data/mcp-reference-memory.jsonl"
      }
    }
  }
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `command` | stdio 必填 | stdio 子进程可执行文件。为空的 stdio 条目被跳过。 |
| `args` | `[]` | 命令行参数数组。 |
| `env` | `{}` | 追加给子进程的环境变量，覆盖继承来的同名变量。 |
| `cwd` | 项目根目录 | 子进程工作目录。 |
| `enabled` | `true` | 设为 `false` 时完全跳过该条目。 |
| `timeoutMs` | `60000` | 单次 MCP 请求（工具调用、资源列举与读取、工具发现与重新列举）的超时预算。 |
| `transport` | 按字段推断 | `stdio` 或 `streamable-http`。省略时按 `url` 存在与否推断：有 `url` 用 streamable-http，否则用 stdio。 |
| `url` | — | streamable-http 的 http(s) 端点，必填。 |
| `headers` | `{}` | streamable-http 每条请求附加的请求头，值同样展开 `${VAR}`。 |
| `reconnect` | `3` | 子进程意外退出后的最大重连次数；`0` 表示不重连。 |
| `maxTotalBudgets` | `10` | 持续回报进度的请求允许超出 `timeoutMs` 的倍数，用作总时长上限。 |

`serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}`；不匹配的条目在启动时记录错误并跳过。`command`、`args`、`env`、`cwd`、`url` 与 `headers` 中的 `${VAR}` 在连接前展开：优先取 `process.env`，`${PROJECT_ROOT}` 固定为项目根目录；未定义的变量保留原样。未声明 `transport` 时按是否存在 `url` 推断，因此 http 条目只需给出 `url`。

stdio 启动前会清除环境变量名匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的项和 `AGENT_*` 项，再把 `env` 中显式配置的值合并回去；因此密钥写在配置的 `env` 里，而不是散落在 shell 环境中。子进程的 stderr 会被持续读取并以 `[mcp:<server>]` 前缀转发到控制台。

streamable-http 条目的 endpoint 示例：

```json
{
  "servers": {
    "remote_docs": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_DOCS_TOKEN}" }
    }
  }
}
```

## 工具命名与注册

模型看到的名字是 `mcp__<serverName>__<rawName>`，例如 `mcp__reference_memory__search_nodes`。`rawName` 来自 server 的 `tools/list`，是 `tools/call` 唯一使用的名字；公开名只用于模型与权限规则，永不回传或反解。名字在 server 不改名工具的前提下保持稳定。

每个发现的工具按普通工具注册：

- `description`、`parameters` 取自 server 的声明；没有 `inputSchema` 时用空对象结构。
- `type` 为 `mcp`，`defaultVisible` 为 `true`，`concurrencySafe` 为 `true`。
- 与内置工具同名时保留内置工具；内置工具优先。同一 server 内重复的工具名只保留第一个。
- 和内置工具一样经过 `user/permissions.json` 的权限门；未列出的工具用 `default` 档。

## 生命周期与调用

启动顺序：读取配置 → 逐条目建立连接（stdio 拉起子进程或连接 HTTP 端点）→ 握手 → `tools/list` → 注册工具。单条目在连接或发现阶段失败时只跳过该 server 并记录错误，不影响其他 server 与应用启动。发现完成后核心才装配工具表，因此模型第一轮就能看到已发现的 MCP 工具，不需要等待异步发现。

`initialize` 返回的 server 能力与身份被记录：资源能力决定是否注册资源工具，instructions 决定提示词段落。

一次工具调用发送 `tools/call`，参数里的 `name` 始终是原始工具名。结果的 `content` 按块顺序拼成文本：文本块取 `text`，其他类型给出一行明确诊断；`isError: true` 的结果以错误文本返回，不伪装成成功。协议错误、连接中断与请求超时都以工具错误文本呈现。

SDK 在客户端侧按协议 schema 校验 server 的响应：`initialize` 结果、工具声明与调用结果不合规都会被拒绝，因此一个不符合规范的 server 会在连接或列举阶段就被跳过，而不是带着半成品数据进入工具表。

## 断线与重同步

每个 server 由一个连接对象持有，连接的生命周期长于任意一个子进程。核心把 MCP 工具写进与 `ToolService` 共享的同一个表，因此工具的增删对所有轮次即时可见，不需要重建服务。

stdio 子进程意外退出，或 HTTP 连接断开时，该 server 的工具与资源随即从表中撤下，模型不会再被推送无法调用的条目；随后按 `reconnect` 的次数以递增延迟重试，重连成功后重新 `tools/list` 并把新工具写回，资源能力也一并重新判定。重试耗尽后该 server 保持离线并记录错误，其余 server 不受影响。

server 发送 `notifications/tools/list_changed` 时，在同一连接上重新列举并替换该 server 的工具集，不重启连接。首次握手失败同样在 `reconnect` 次数内重试，仍失败则跳过该 server，不影响其他 server 与应用启动。

调用一个处于断开状态的 server 立即返回明确错误，不等待也不悬挂。

退出时由 `launcher.js` 的 `before-quit` 调用 `core.mcp.close()`：停止重连循环，关闭 stdio 子进程与 HTTP 连接，并让在途调用以错误结束而不是悬挂。

## 资源

有 server 在 `initialize` 中声明 `resources` 能力时，注册三个共享工具，`server` 是参数而非工具名的一部分，因此工具表不随 server 数量增长：

| 工具 | 作用 | 必填参数 |
| --- | --- | --- |
| `list_mcp_resources` | 列举该 server 的资源 | `server`，可选 `cursor` |
| `list_mcp_resource_templates` | 列举参数化 URI 模板 | `server`，可选 `cursor` |
| `read_mcp_resource` | 按 URI 读取一个资源 | `server`、`uri` |

三个工具都只读且可并发，并和其余工具一样经过 `user/permissions.json` 的权限门（未列出时用 `default` 档，本项目默认 `ask`）。`server` 在发起任何网络请求前先对照当前有资源能力的 server 校验，未知名字直接报错并列出已知名字。没有任何资源型 server 时这三个工具不注册，server 失去资源能力或断开时随即撤下。

结果按 JSON 输出并冠以 `MCP server: <name>`。资源内容里的 `blob` 是 base64 二进制，不进入模型历史，改以字符数说明，与其余 JSON 一同返回。

同一批 server 还贡献一段 `mcp-resource-servers` 系统提示词段落，列出当前可用的 server 名（升序、JSON 数组），模型据此选择 `server` 参数；没有资源型 server 时该段落不出现。

## server instructions

server 在 `initialize` 中提供的 instructions 以 `mcp:<server>` 段落注入系统提示词，正文为 server 原文，多个 server 之间按名字码元序排列。该内容由外部提供，因此不参与变量插值：其中的 `{{name}}` 原样保留，不会被替换也不会被当作错误变量。server 断开时其段落随之消失，不保留过期文本。

## 协议边界

握手、协议版本协商、JSON-RPC 分帧（stdio 的换行分隔、HTTP 的 SSE 与会话 id）、列表分页与响应 schema 校验都由 SDK 承担；本项目声明空的客户端 `capabilities`，`clientInfo` 标识为 `agent`。

已消费的 server 通知只有 `notifications/tools/list_changed`，交由 SDK 的 list-changed 机制处理：只有 server 声明 `tools.listChanged` 时才订阅，连续通知会合并为一次刷新（SDK 默认 300ms 防抖），刷新由 SDK 完成并直接给出最新工具列表，本项目不再自行列举。`resources/list_changed` 不响应：资源工具每次调用都实时向 server 列举，因此模型侧看到的资源集不会过期，但资源工具与 `mcp-resource-servers` 段落的注册状态只在连接建立、断开或重连时重算。

每个请求都带上 `timeoutMs` 作为超时预算；未配置时沿用本项目的 60 秒默认值，不依赖 SDK 自带的默认值。

每个请求都携带调用方的取消信号（`exec.signal`），因此用户停止一轮对话时，正在等待的 MCP 调用会立即结束而不是等到超时。取消的调用按 `Error: tool call aborted` 返回。

## 进度

请求都声明接收进度。server 每发一条进度通知，该请求的 `timeoutMs` 预算就重新计时，因此一个持续汇报进展的慢操作不会因为总耗时长于预算而被判超时。为避免一个不停汇报的 server 永不结束，总时长上限为 `timeoutMs × maxTotalBudgets`（默认 `60000 × 10`）。没有任何进度通知时，仍按单次 `timeoutMs` 计算。

进度只写入控制台日志（`[mcp] server "<name>" progress <n>/<total> <message>`），不进入模型对话；模型只看到最终的调用结果。

不支持的部分：图片与音频内容投影（非文本内容块只留一行诊断）、资源订阅（`resources/subscribe`）、MCP prompt 模板、采样与 elicitation、roots、连接状态管理界面、tasks extension。
