# ACP 适配层（Agent Client Protocol）

## 范围

ACP 是 **客户端驱动 Agent** 的标准协议（类似 AI Agent 的 LSP），不是 Agent-to-Agent（A2A）。本项目的 `core/acp` 只做边缘适配：

- `Core` 仍然是 AgentRuntime、会话、工具、存储；
- Electron 客户端继续走现有私有 HTTP / IPC RPC；
- 外部 ACP 客户端（Zed、其他 Harness、自动化程序）通过独立 `acp-server.js` 的 stdio JSON-RPC 驱动同一个 Core。

不改写 AgentRuntime 主循环，也不把 ACP 变成 Core 的内部传输层。

## 入口

```bash
node acp-server.js
# 或
pnpm acp
```

stdout 是 JSON-RPC 通道，启动时会把 `console.log/info/debug` 重定向到 stderr；否则 Core 服务里的普通日志会污染协议流。

支持的参数与 `createCore()` 一致：

```bash
node acp-server.js --provider=deepseek --model=deepseek-chat --api-key=...
```

缺省读取现有配置；模型/Provider 仍由 `config.resolveTarget()` 决定。

## 方法

| 方法 | 状态 | 说明 |
|---|---|---|
| `initialize` | 支持 | 返回 `PROTOCOL_VERSION`、文本 prompt 能力、`session/list`/`resume`/`close` 能力 |
| `authenticate` | 空实现 | 本项目没有 ACP 侧登录 |
| `session/new` | 支持 | 以 ACP `cwd` 创建 workspace + normal session；拒绝 `additionalDirectories` 和非空 MCP servers |
| `session/list` | 支持 | 列出 normal session；可用 `cwd` 过滤；不做 cursor 分页 |
| `session/resume` | 支持 | 要求 `cwd` 与 session 所属 workspace 一致；不允许重复 resume 已激活会话 |
| `session/close` | 支持 | 中断并移出当前进程的 AgentRegistry；不删除持久会话 |
| `session/prompt` | 支持 | 只接受 text content block；一个 session 同时只能有一个 active prompt |
| `session/cancel` | 支持 | 调用 `agent.interrupt()`；`session/prompt` 返回 `stopReason:"cancelled"` |

未声明、也未实现：`session/load`、`session/delete`、`session/fork`、`session/setConfigOption`、MCP mounts、ACP Client（作为 subagent 后端）。

## 事件映射

`core.agent.chat` 的 `onEvent` 被转换为 `session/update`：

| Core 事件 | ACP update |
|---|---|
| `token` | `agent_message_chunk` |
| `reasoning` | `agent_thought_chunk` |
| `tool_call` | `tool_call` |
| `tool_result` | `tool_call_update` |
| `approval-request` | `session/requestPermission` |
| `turn-end` | 只写 `stopReason`，作为 `session/prompt` 的结果返回 |

`tool_result` 的文本被包成 ACP `content` block；状态按 `isError` 映射为 `failed` / `completed`。

## 权限桥接

Core 的 `permission === "ask"` 工具会阻塞在 `InteractionService.requestApproval()`，并发出带内部 `id` 的 `approval-request`。ACP 适配器收到后：

1. 向客户端发 `session/requestPermission`，只给 `allow-once` / `reject-once` 两个一次性选项；
2. 根据客户端选择调用 `core.interactions.approve(id, "approve" | "deny")`；
3. 客户端报错、连接关闭、或返回 `cancelled` 时一律 `deny`，保证 turn 不会永久挂起。

`autonomous` 会话会在 Core 内自动 deny，不适合作为 ACP 的权限策略；ACP 会话按普通交互处理。

## 已知边界

- ACP 没有标准的 `ask_user_question` / `plan_review` 请求。当前适配器对用户问题返回空选择，对 plan review 自动接受；工具权限仍单独走 `session/requestPermission`。
- ACP session id 直接复用内部数字 session id 的字符串形式；`session/resume` 依赖它，因此不是随机 UUID。
- `session/list` 当前返回全部 normal 会话，只做 `cwd` 过滤，不实现分页。
- 首版不做 MCP server mounts，`session/new` 收到非空 `mcpServers` 会返回 `invalidParams`。
- `session/prompt` 的 context 只取文本；图片、音频、resource 等 block 目前拒绝。
- AgentRuntime 的流式 token 事件已经映射；如果底层模型/工具不发 token，客户端只会看到工具更新和最终 stop reason。
- `acp-server.js` 与 Electron 不能共享同一个 `data/store.db` 的写锁假设；两者同时运行属于多 Host 场景，现有存储没有跨进程租约。
