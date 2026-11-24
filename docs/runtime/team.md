# Agent Team 共享任务板

## 范围

Agent Team 让一棵 subagent 树里的成员共享一块持久任务板。它解决的是「多个 agent 同时干活时，谁在做什么、下一步能做什么、谁改了哪一版」的问题，不创建新的成员体系，也不创建独立工作目录。

- 成员就是 `subagents` 树：根会话为 Lead，所有可达的可续后代都是队友。
- 一块看板 = 一个树根会话。`team_id` 就是根会话 id，不另设 Team id。
- 任务板只做协作事实，不负责调度、唤醒、重试或文件锁。
- 与 `todo_write` 的区别：todo 是单个 agent 一轮内的清单；Team 任务跨会话持久、带 owner 和依赖。

## 1 Team 模式

本部署把 Team 模式做成**隐式开启**：任意树成员都能调用四个任务工具，第一次 `team_task_create` 即建板。没有 DSH 的 root 级开关、默认关闭、UI 投影。

这样做的代价是工具与提示段对所有会话常驻（请求前缀稳定），收益是不用为了试用任务板先加一套模式存储与 UI。若以后要照搬 DSH 的按 root 开关，需要补 `team_modes` 表与工具可见性条件；任务表不用改。

## 2 数据模型

一张 `team_tasks` 表，一行是一个完整任务快照：

| 列 | 含义 |
|---|---|
| `team_id` | 根会话 id；看板归属 |
| `seq` / `task_id` | 团队内递增序号与模型侧 id `task-<seq>`；删除行保留，序号不复用 |
| `revision` | 每次变更 +1；`team_task_update` 用它做 CAS |
| `subject` | 标题，≤200 字符 |
| `description` | 详情与验收标准，≤16384 字符 |
| `status` | `pending` / `in_progress` / `completed` / `deleted` |
| `owner_id` / `owner_name` | 认领或改派时一起写入；释放、重开、取消改派时一起清空 |
| `blocked_by` | JSON 数组，依赖的任务 id |
| `write_scopes` | JSON 数组，相对 workspace 的路径前缀，只作告警 |
| `created_at` / `updated_at` | 时间事实 |

一个看板最多 256 个未删除任务；`maxTasks` 可在 `TeamService` 构造时改。删除任务保留为墓碑，不占额度、不进 `team_task_list`，但 `team_task_get` 仍能读到。

## 3 工具契约

| 工具 | 行为 |
|---|---|
| `team_task_create` | 任意成员创建一条无 owner 的 `pending` 任务；可带 `blocked_by` 与 `write_scopes` |
| `team_task_list` | 按 `status` / `owner` / `unowned` / `ready` 过滤，`cursor` + `limit`（1–100）分页；删除任务不出现 |
| `team_task_get` | 读一条任务的最新快照，包括删除墓碑 |
| `team_task_update` | 用 `expected_revision` 做 CAS，执行 claim / release / edit / set_dependencies / complete / reopen / reassign / delete |

结果都是紧凑 JSON 任务视图：

```json
{
  "id": "task-1",
  "revision": 2,
  "subject": "Review diff",
  "description": "Check the implementation and tests.",
  "status": "in_progress",
  "owner": "reviewer",
  "blockedBy": [],
  "writeScopes": ["core/team"],
  "ready": false,
  "writeScopeWarnings": []
}
```

`ready` 只对 `pending` 计算：所有 `blockedBy` 任务都 `completed` 才为 true。`writeScopeWarnings` 在 pending / in_progress 任务与另一个 in_progress 任务路径前缀重叠时给出 `write scopes overlap with task-N`，从不阻断操作。

## 4 授权与状态机

- 任意成员可创建任务；创建者不自动成为 owner。
- `claim` 只能由当前无 owner（或 owner 就是自己）的成员发起，且任务必须 `pending`、依赖已完成；成功后 `in_progress` 并写 owner。
- `release` / `edit` / `set_dependencies` / `complete` / `reopen` / `delete`：owner 或 Lead 可做。
  - `release` 只接受 `in_progress`，回到 `pending` 并清 owner。
  - `complete` 只接受 `in_progress`。
  - `reopen` 只接受 `completed`，回到 `pending` 并清 owner。
  - `delete` 只能删无未删除依赖者的任务。
- `reassign` 只有 Lead 能做：目标必须是根或同一棵树里的可续后代；省略 `owner` 表示取消指派并回到 `pending`；指派前任务必须依赖就绪。
- 任何变更都要带当前 `revision`。过期写返回 `stale team task "<id>"; current revision is N`，不覆盖新版本。
- 删任务后，依赖它的任务不能 claim；必须先 `set_dependencies` 换掉或删除依赖者。

## 5 依赖与写范围

- 依赖是 DAG，创建与 `set_dependencies` 都检查：不得自依赖、重复、指向不存在或已删除任务、成环。
- 依赖只控制 `claim` 与 `reassign`；`complete` 不要求被依赖者完成（DSH 同语义）。
- `write_scopes` 规范化：反斜杠转 `/`、去掉前缀 `./` 与尾部 `/`；拒绝绝对路径、盘符、`.`、`..` 和空段；重复项合并。
- 写范围只是告警：Bash、格式化器、代码生成器仍可能绕过它。整合方必须自己看最终 diff 并跑测试。

## 6 与子代理控制面的关系

- 任务变更**不会**结束 `wait_agent`、不会写 inbox、不会唤醒 idle 成员。
- 需要队友行动时用 `send_message` 明确通知；任务板只记录协作事实。
- 成员用 `list_agents` 的名称（`lead`、`reviewer`、`reviewer/checker`）做 owner 过滤与改派；名称解析不授予权限，授权仍按树关系与 owner 判定。
- 子代理被释放或冷唤醒不影响任务板：看板行在 `team_tasks`，归属按会话 id，不依赖实例驻留。

## 7 上限与失败

| 项 | 值 |
|---|---|
| 未删除任务 | 256 / 看板 |
| subject | 200 字符 |
| description | 16384 字符 |
| list 单页 | 1–100，默认 50 |
| 任务 id | `task-<seq>`，看板内单调 |

失败统一抛回工具调用方，由 `runTool` 渲染成 `Error: <message>`：

- 未知任务、未知 blocker、未知 owner、非本树成员
- 过期 revision、无权限（非 owner 且非 Lead）、Lead 专属的 reassign
- 未就绪 claim、非法状态转换、仍有依赖者时删除
- 任务上限、循环依赖、非法写范围

## 8 测试

- `core/team/team.test.js`：8 条，覆盖创建/列表/认领/完成、依赖解锁、CAS 与授权、Lead 改派、写范围告警、删除墓碑与依赖者保护、存储层 CAS 败者、上限与环检测。
- 工具冒烟：真实 `team_tasks` 表 + `tools/team_task_create/get`，验证紧凑 JSON 视图。
- `createCore` 冒烟：`core.team` 装配、38 个工具、四个 `team_task_*` 已加载。
- Agent 轮次冒烟：临时 mock 模型返回 `team_task_create` 调用，node-graph 主循环完成 `tool_call → tool_result → 任务入板`，证明 `exec.team` 注入生效。
- 全量 `node --test`：360 tests / 360 pass / 0 fail。

## 9 与 DSH 的差异（明确不做）

- 不做 root 级 Team 模式开关与默认关闭；本部署隐式开启。
- 不做 Lead Session 日志里的 `team/task` 事件与 `agentTeam` 浏览器投影；本部署以 `team_tasks` 表为权威，UI 尚未接入。
- 不做跨进程/多主机看板、worktree、文件锁、自动释放 owner。
- 不做历史 `team/member`、`team/message/*` 邮箱记录的兼容；消息与成员仍由 `subagents` 运行时负责。
