## 工具实现方案

> 状态（2026-11-03）：P0 已实现 `read` / `write` / `edit` / `glob` / `grep` / `bash`；
> P1 已实现 `ask_user_question`（UI 挂起问答）；P2 已实现 `todo_write` 和
> `create_goal` / `get_goal` / `update_goal`（goal 自动续轮待做）；
> P3 已实现 `web_search`（Tavily）/ `web_fetch`（HTTP + HTML→Markdown）；
> P5 已提前实现 plan 模式 + `exit_plan_mode`。
> `write` / `edit` 的观察约束、`bash` 的超时/截断、`glob`/`grep` 的 spill 均已落地。
> 工具优先级、模型接口约定和后续阶段见 `docs/tool-plan.md`。

### 目录约定
- 工具代码：项目根 `tools/`
- 工具文档：本文件 `docs/tool.md`

### 工具注册机制
目录化注册（扫描 tools/*/registry.json）

registry.json 字段：
- `name` / `description` / `parameters` / `type` / `entry`：工具身份与实现入口（`entry` 默认 `run.js`）
- `prompt`（可选）：该工具贡献到 system prompt 的指引段落；order 由工具名查固定表
- `promptSection`（可选）：多个工具共享同一段指引时使用（goal 三件套用 `goal`）
- `timeoutMs`（可选）：执行器预算；`concurrencySafe`（可选）：并发标记
- `defaultVisible`（可选，默认 true）：false 时默认不下发给模型（如 `calculator`）
- `result`（可选，默认 `text`）：`text` / `json`

工具权限不在 registry 里声明，统一由 `user/permissions.json` 决定（见「工具权限」）。

工具实现导出 `async run(args, exec)`；`exec.cwd` 是本轮会话所属 workspace 的绝对路径，
`exec.sessionId` 用于 fs observation 等会话态。返回值是模型可见文本（string），或
`{ text, meta }`；`meta` 只进 UI/DB，不进模型消息。工具抛错统一渲染为 `Error: ...`。

### 工具状态
- 已实现（P0）：`read`、`write`、`edit`、`glob`、`grep`、`bash`
- 已实现（P1）：`ask_user_question`
- 已实现（P2）：`todo_write`、`create_goal`、`get_goal`、`update_goal`
- 已实现（P3）：`web_search`、`web_fetch`
- 已实现（P5，提前）：plan 模式 + `exit_plan_mode`
- 默认隐藏：`calculator`、`get_current_time`（`defaultVisible: false`）
- 再后：jobs、present、skill、subagent、workflow 等；
  见 `docs/tool-plan.md` 的矩阵与里程碑

### 工具执行
tools/pre-execute

### read（读文本文件）
- 注册：`tools/read/registry.json`；实现：`tools/read/run.js`
- 参数：`file_path`（必填）、`offset`（1 起，默认 1）、`limit`（默认/最大 2000 行）
- 返回：纯文本信封，而非 JSON：
  ```
  <path>/abs/path</path>
  <type>file</type>
  <content>
  1: first line
  2: second line

  (End of file - total 2 lines)
  </content>
  ```
- 上限：单行截断 2000 字符、单次最多 50KB；达到上限时 footer 提示用 `offset` 续读
- 大文件：`stat.size >= 10MB` 走流式扫描，不整文件读入内存
- 报错：不存在、非普通文件、无权限、offset 超出 EOF、UTF-8 首块含 NUL 判为二进制
- 审批：由 `user/permissions.json` 的 `read` 档位决定（当前为 `allow`，不弹授权）；绝对路径照读，不做 workspace 包含性限制

### web_search（联网搜索）
- 注册：`tools/web_search/registry.json`；实现：`tools/web_search/run.js` + `tools/lib/web/`
- 参数：`queries`（必填，1–4 条，合并去重）
- provider：Tavily `POST /search`；结果映射为 `{ answer?, sources[], truncated }`
- 多 query：并发执行、按 rank 轮转合并、按 URL 去重，最多 8 个源；answer 以 `### <query>` 分段
- 结果文本（与 DSH 一致）：外部内容声明 → answer → `Sources:` markdown 列表（含 snippet 与日期）→ 截断提示 → 引用提示；无结果时为 `No results found.`
- 配置：`user/settings.json` 的 `web.tavilyApiKey`（`TAVILY_API_KEY` 兜底）；可选 `web.tavily.{baseUrl,searchDepth,includeAnswer}`
- 上限：30s 超时；结果数 8、query 数 4 固定在代码里，与 registry 描述保持一致
- 审批：`web_search` 当前为 `allow`（只读外部请求）；缺 key 时返回 `Error: web_search is unavailable: missing Tavily API key ...`

### web_fetch（抓取网页）
- 注册：`tools/web_fetch/registry.json`；实现：`tools/web_fetch/run.js` + `tools/lib/web/`
- 参数：`url`（必填，HTTP(S)）
- 抓取策略（对齐 DSH `web-fetch-http`）：
  - URL ≤ 2048 字符、仅 http/https、禁止内嵌凭据
  - DNS 解析后校验整个地址集，拒绝回环/内网/非公网 IP，并把地址 pin 到连接
  - 仅跟随同源重定向（最多 5 跳）；跨域重定向报错，要求直接重试目标 URL
  - 响应体最多 5MB、解码后 10 万字符；超限时截断并标记
  - `Content-Type`：`text/html`/XHTML → turndown（GFM 表格）转 Markdown；其他 `text/*`、JSON/XML 原样返回；其他类型报 `unsupported content type`
  - 输出整体上限 20 万字符；截断时追加 `(Content truncated. Fetch a more specific URL or section for the full text.)`
- 结果文本：`Fetched <url> (HTTP <code>)` + 外部内容声明 + 正文；4xx/5xx 仍返回正文与状态码
- 依赖：`turndown` + `@joplin/turndown-plugin-gfm`（HTML→Markdown）、`ipaddr.js`（公网地址判定）
- 审批：`web_fetch` 当前为 `allow`（只读外部请求）

### 具体约定
参照deepseek-harness具体的工具与模型通信的约定

### 权限请求
approval-request { id, callId, name, arguments, permission }

- `permission: "ask"`：等待用户点击批准/拒绝（`id` 回传给 `approval`）
- `permission: "allow"`：无需等待，直接执行
- `permission: "deny"`：不执行，工具结果写 `{ "error": "permission denied" }`，`call.status = "denied"`
- `callId` 始终指向对应的 tool call，用于把审批卡片挂到正确的 `tool-call-card`

### 工具权限（user/permissions.json）
每轮对话开始时读取一次；本机配置，`user/` 不入 git。格式：

```json
{
  "default": "ask",
  "tools": [
    { "name": "read", "permission": "allow" },
    { "name": "bash", "permission": "ask" }
  ]
}
```

- 档位：`allow` / `ask` / `deny`；未列出的工具取 `default`，`default` 缺省 `ask`
- 文件缺失、JSON 损坏、`default` 或某工具档位非法：该处按 `ask` 处理并 `console.error`（fail closed）
- 未注册的工具名允许先写（例如预留的 `write`），运行时只查当前可见工具

### 文件写精细控制（user/fs-policy.json）
对 `write` / `edit` 两类文件写工具，在工具级档位之上叠加**按路径**的精细控制：可按目录、按文件、按 glob 自动 `allow`（跳过审批）或 `deny`（直接拒绝）。与 `permissions.json` 并列，本机配置，`user/` 不入 git。格式：

```json
{
  "rules": [
    { "path": "docs/**", "permission": "deny" },
    { "path": "src/**/*.test.js", "permission": "allow" },
    { "path": "/abs/secrets/**", "permission": "deny" }
  ]
}
```

- 作用域：仅 `write` / `edit`。其他工具完全由 `permissions.json` 决定。
- 匹配基准：每条 `path` 既按**绝对路径**匹配，也按**相对 workspace 根**匹配（`docs/**` 可匹配任意位置下的 `docs/` 子目录，无需写全绝对前缀）。`**` 跨任意层级，`*` 单段，`?` 单字符。
- 决策顺序：**先扫 deny，任一 deny 命中即拒绝**（否决更早的 allow）；否则首条命中的 allow/ask 生效；均未命中则回退到 `permissions.json` 的工具级档位。
- 失败行为：文件缺失、JSON 损坏、某条规则缺 `path` 或档位非法——坏规则被丢弃（含整体损坏时忽略全部规则），完全回退到 `permissions.json`，绝不悄悄放宽或收紧（fail open 到原门控）。

### 模型通信
#### 发送工具清单
payload["tools"] = [
  {
      "type": "function",
      "function": {
          "name": tool.name,
          "description": tool.description,
          "parameters": tool.parameters,
      },
  }
  for tool in tools
]

#### 处理工具调用
for raw_call in raw_message.get("tool_calls") or []:
    tool_calls.append(
        ToolCall(
            id=raw_call["id"],
            name=raw_call["function"]["name"],
            arguments=raw_call["function"]["arguments"],
        )
    )
return Message(
    role="assistant",
    content=raw_message.get("content"),
    reasoning_content=raw_message.get("reasoning_content"),
    tool_calls=tuple(tool_calls),
)

## deepseek-harness参考

所有通过 defineTool 注册的工具，共 55 个，分布在 23 个 tool-*包中。


  文件 / Shell 类

  ┌────────────────────┬──────────────────────────────────────────────────┐
  │        工具        │                     实现文件                     │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ read               │ packages/fs/tool-fs/src/read.ts                  │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ read_image         │ packages/fs/tool-fs/src/read-image.ts            │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ write              │ packages/fs/tool-fs/src/write.ts                 │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ edit               │ packages/fs/tool-fs/src/edit.ts                  │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ str_replace_editor │ packages/fs/tool-str-replace-editor/src/index.ts │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ grep               │ packages/fs/tool-fs-search/src/grep.ts           │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ glob               │ packages/fs/tool-fs-search/src/glob.ts           │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ bash               │ packages/shell/tool-bash/src/index.ts            │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ bash（持久版）     │ packages/shell/tool-bash-persistent/src/index.ts │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ pwsh               │ packages/shell/tool-pwsh/src/index.ts            │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ pwsh（持久版）     │ packages/shell/tool-pwsh-persistent/src/index.ts │
  └────────────────────┴──────────────────────────────────────────────────┘

  终端 / 任务（jobs）

  ┌────────────────────────────────────────┬──────────────────────────────────────────────┐
  │                  工具                  │                   实现文件                   │
  ├────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ terminal_open / terminal_send /        │ packages/terminal/tool-terminal/src/index.ts │
  │ terminal_read / terminal_signal /      │                                              │
  │ terminal_close / terminal_list         │                                              │
  ├────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ job_list / job_output / job_kill       │ packages/jobs/tool-jobs/src/index.ts         │
  └────────────────────────────────────────┴──────────────────────────────────────────────┘

  子代理 / 团队（subagent / agent-team）

  工具: spawn_subagent? 实为 report
  实现文件: packages/subagent/tool-subagent-report/src/index.ts
  ────────────────────────────────────────
  工具: list_subagent_models
  实现文件: packages/subagent/tool-subagent/src/list-models.ts
  ────────────────────────────────────────
  工具: list_agents
  实现文件: packages/subagent/tool-subagent-control/src/list-agents.ts
  ────────────────────────────────────────
  工具: send_message / interrupt_agent
  实现文件: packages/subagent/tool-subagent-control/src/index.ts
  ────────────────────────────────────────
  工具: list_agents / interrupt_agent / spawn_teammate / wait_agent / team_task_create /
  team_task_get / team_task_list / team_task_update
  实现文件: packages/experimental/tool-agent-team/src/index.ts

  会话查询 / 上下文

  工具: session_search / session_event_read / session_event_search / session_event_trace /
  session_trace
  实现文件: packages/session-query/tool-session-query/src/index.ts

  目标 / 待办 / 技能 / 交互

  ┌─────────────────────────────────────┬─────────────────────────────────────────────────┐
  │                工具                 │                    实现文件                     │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ create_goal / get_goal /            │ packages/goal/tool-goal/src/index.ts            │
  │ update_goal                         │                                                 │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ todo_write                          │ packages/todo/tool-todo/src/index.ts            │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ skill                               │ packages/skill/tool-skill/src/index.ts          │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ ask_user_question                   │ packages/interaction/tool-ask-user/src/index.ts │
  └─────────────────────────────────────┴─────────────────────────────────────────────────┘

  扩展 / 工作流 / 网络

  ┌───────────────────────────────────────┬───────────────────────────────────────────────┐
  │                 工具                  │                   实现文件                    │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ cordis_define / cordis_inspect_list / │ packages/extensions/tool-cordis/src/index.ts  │
  │ cordis_inspect_query /                │                                               │
  │ cordis_inspect_self / cordis_run /    │                                               │
  │ cordis_stop / cordis_undefine         │                                               │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ lsp                                   │ packages/lsp/tool-lsp/src/index.ts            │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ ralph                                 │ packages/workflow/tool-ralph/src/index.ts     │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ web_fetch / web_search                │ packages/web/tool-web/src/fetch.ts、search.ts │
  └───────────────────────────────────────┴───────────────────────────────────────────────┘

packages/shell/tool-bash/src/index.ts -> ctx.tools.register(defineTool({...})
 
### 内置工具 ctx.tools @deepseek-ai/dsh-tool-*
能力域	工具包	一句话
终端	tool-bash / tool-bash-persistent / tool-pwsh / tool-pwsh-persistent / tool-terminal	跑命令、长驻会话
文件	tool-fs / tool-fs-search / tool-str-replace-editor	读写、搜索、精确编辑
网络	tool-web	web_search / web_fetch
代码	tool-lsp	跳转定义、找引用、hover
委托	tool-subagent / tool-subagent-control	把活派给子 Agent
调度	schedule	定时提醒
目标	tool-goal	会话级目标
作业	tool-jobs	后台作业输出/列表/终止
待办	tool-todo	todo_write
技能	tool-skill	加载技能
会话检索	tool-session-query	历史搜索/轨迹
提问	tool-ask-user	问用户
自省	tool-cordis	查询 Host/Client 契约，定义并管理版本化动态插件
编排	tool-workflow / tool-ralph	JS 编排、Ralph 迭代
模型可带	由各 seam 决定	呈现与调度

terminal:
ctx.bsh
ctx.bash-persistent
filesystem:
ctx.fs read / read_image / write / edit
ctx.fs_search glob / grep
ctx.str_replace_editor
ctx.attachment
delegate:
ctx.subagents subagent
ctx.subagent_control send_message / interrupt_agent / list_agents
goal:
ctx.goal get_goal / create_goal / update_goal
ctx.jobs
ctx.todo todo_write
interact:
ctx.session-query session_search/session_trace/session_event_read
ctx.userQuestions ask_user_question
ctx.schedule schedule_create
web:
ctx.web web-search web-fetch
code:
ctx.lsp goToDefinition / findReferences / goToImplementation / hover
chestrate:
ctx.cordis cordis_inspect
ctx.workflowEngine workflow
ctx.ralph
