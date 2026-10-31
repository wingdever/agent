### session_body（jsonb，消息数组）
对应 ui.md 的 `request-prompt` / `response-message` 及其内部组件（thought / tool-call / approval-request / answer / ask-user-question / ask-user-prompt）。
```json
{
  "messages": [
    {
      "id": "msg_01",
      "role": "user",
      "kind": "request",
      "created_at": "2026-01-01T00:00:00Z",
      "content": "把 utils.js 的 add 重命名为 sum"
    },
    {
      "id": "msg_02",
      "role": "assistant",
      "kind": "response",
      "created_at": "2026-01-01T00:00:01Z",
      "parts": [
        { "type": "thought", "text": "先读取文件定位 add 函数" },
        { "type": "approval-request", "tool": "edit", "detail": "edit(src/utils.js)", "status": "pending" },
        { "type": "ask-user-question", "question": "找不到 src/utils.js，请确认路径", "options": ["src/util.js", "lib/utils.js"] },
        { "type": "tool-call", "tool": "text-file", "op": "read", "args": {"path":"src/utils.js"}, "result": {"lines":42}, "status": "done" },
        { "type": "answer", "text": "已将 3 处 add 重命名为 sum，构建通过" },
        { "type": "ask-user-prompt", "text": "是否同步更新单元测试？" }
      ]
    }
  ],
  "trace": [
    { "node": "主 Agent", "children": [
      { "node": "子 Agent: 检索", "status": "done" },
      { "node": "子 Agent: 改写", "status": "done" }
    ]}
  ]
}
```

parts 中各 type 与 ui.md Name 的映射：
- `thought` → `thought` / ChainOfThought
- `approval-request` → `approval-request`（横切 HumanControl）
- `ask-user-question` → `ask-user-question`
- `tool-call` → `tool-call`，其 `tool` 取值对应横切子类：`text-file`(read/write/edit/search) / `bash`(grep/list/file/run) / `sql`(add/delete/query/insert) / `script`(run) / `web`(search)
- `answer` → `answer`
- `ask-user-prompt` → `ask-user-prompt`

`trace` 字段对应 `trajectory-tab` 内的 `sub-agent-tree` / `agent-trace-node`。

配置说明：composer 的 `mode-selector` 选择运行模式（bare-chat / turn-step / goal-plan，详见 behavior.md），`permission-selector` 读取 `confs` 表（经 `sessions.conf_id` 关联）的 `permission` 字段；模型选择已移入 settings-modal 的 `model-selector`。