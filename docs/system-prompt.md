## System prompt 装配

实现：`core/system-prompt.js`；调用点：`core/index.js` 的 `chat()`。

### 时机与范围
- system prompt 是 **session 首轮**的：该 session 的第一次 `chat()` 装配一次，之后所有轮次复用同一份（从 DB 读回），不再重新生成。
- 它只在首轮落库一次、只向 UI 发一次 `system-prompt` 事件；后续轮次不新增 system 消息，也不重复显示。
- 运行时上下文（cwd / 时间 / 模型 / platform）因此在 session 内冻结；要更新它就新建一个 session（旧 session 不会因设置变更而重装配）。
- 没有 system 行的旧 session（或首次升级后的会话）会在下一次 `chat()` 时装配一次并固定下来，该轮即为它的“首轮”。
- 请求里 system prompt 与 user_input 是两个独立 message。首轮 step 0 落库：
  - `messages(role="system", seq=0)` → `contents`
  - `messages(role="user", seq=1)` → `contents`
  - `messages(role="assistant", seq=2)`、tool 消息从 seq 3 起
- 后续轮次只落 user/assistant/tool：`user seq=0`、`assistant seq=1`、tool 从 seq 2 起。
- Chat Completions 是无状态的：每次 HTTP 请求仍会带同一个 system 消息，但它在会话消息里只存在一份、内容不再变化。
- bare-chat 没有 session，仍按每轮装配；它不落库，也没有 agent-request，因此不显示 system prompt。

### 段落与顺序
section 按 `order` 升序拼接，同 order 按 name 排序；空文本段落直接丢弃；同名 section 后者覆盖前者。

| section | order | 来源 |
|---|---|---|
| `harness:identity` | -1000 | `user/settings.json` 的 `identity`，缺省 `You are an AI agent.` |
| `deployment:persona` | 0 | `user/settings.json` 的 `persona`，缺省空（不渲染） |
| `tool:<name>` | 1000+ | 工具 `registry.json` 的 `prompt` 字段，按工具名排序 |
| `runtime:context` | 10000 | 自动生成，固定在末尾 |

只有本轮可见的工具（`toolNames`）才贡献 `tool:*` 段落；bare-chat 传 `toolNames: []`，因此只有身份、persona 和运行时上下文。

### 变量
section 文本里的 `{{name}}` 在渲染时替换；未知变量直接抛错，不静默保留。当前提供：

- `{{cwd}}`：本轮 cwd（会话所属 workspace 的 `folder_path`；无会话时 `process.cwd()`）
- `{{model}}`：本轮实际使用的模型名

### 运行时上下文
固定追加四行：

```
Current working directory: "...".
Current time: 2026-11-02T19:05:00+08:00 (Asia/Shanghai).
Current model: deepseek-flash.
Platform: linux (x64).
```

### 配置
`user/settings.json` 可写 `identity` / `persona`，例如：

```json
{ "identity": "You are a coding agent.", "persona": "You are powered by the {{model}} model." }
```

设置写入走 `settings` 的 `writeSettings` 合并，不会清掉其他字段。

### UI 展示
- 布局树：`step* → agent-request? → (system-prompt? + user-input)`。
- `system-prompt` 用 `<details>` 折叠，summary 为「系统提示词」；有内容才渲染，旧会话没有 system 行则只显示 `user-input`。
- 只在 session 首轮的 step 0 显示一次；后续轮次的 agent-request 只有 `user-input`。实时由 `system-prompt` 事件插入（仅首轮发出），回放由 DB 的 system 行插入。
