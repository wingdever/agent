## 工具实现方案

### 目录约定
- 工具代码：项目根 `tools/`
- 工具文档：本文件 `docs/tool.md`

### 工具注册机制
目录化注册（扫描 tools/*/registry.json）

registry.json 字段：
- `name` / `description` / `parameters` / `type` / `entry`：工具身份与实现入口（`entry` 默认 `run.js`）
- `prompt`（可选）：该工具贡献到 system prompt 的指引段落，按工具名排序渲染

工具权限不在 registry 里声明，统一由 `user/permissions.json` 决定（见「工具权限」）。

工具实现导出 `async run(args, exec)`；`exec.cwd` 是本轮会话所属 workspace 的绝对路径，工具据此解析相对路径。

### 等待实现列表
tools:
bash, read,
textfile_write,textfile_etext_grep,file_touch,file_remove,file_stat,dir_mkdir,dir_rmdir,dir_list,python_run,sql_insert,sql_delete,sql_select,sql_update,web_search,web_fetch

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
 