# 会话树与 fork

会话历史以树形组织：主会话可以 fork 出子会话，子会话可以再 fork 出孙会话。fork 出来的会话**不复制**父的历史，而是记录「继承自哪个父、继承到哪条消息为止」，回放时递归拼接。压缩把祖先内容吸收进本会话的摘要，从而切断对祖先的依赖。

与 dsh 的关系：dsh 的 fork 把父会话事件日志的已完成轮次前缀作为子会话的 seed（`dsh-subagent-fork-in-process/lib/index.js:22-27`，`dsh-subagent/lib/index.js:1424-1450`）。本项目没有事件日志，用「引用父历史 + 压缩吸收」实现等价语义。

## 1. 会话关系

- `sessions.kind`：`normal`（主会话）与 `subagent`（子会话）。fork 出来的子会话 `kind=subagent`。
- `subagents` 表记录一次委派：谁派了谁。spawn 与 fork 都写这张表。
- `session_forks` 表记录历史继承：子会话继承哪个父、继承到哪。只有 fork 写这张表。
- 两个关系在 fork 场景下指向同一个父，但语义不同：委派用于轨迹与结算关联，继承用于历史回放。

## 2. session_forks

```sql
create table session_forks (
  child_session_id     integer primary key,
  parent_session_id    integer not null,
  parent_boundary_seq  integer not null,   -- 父会话最后一条已完成消息的 surface_seq
  created_at           timestamp not null default now()
)
```

- `child_session_id` 是主键：一个子会话只能 fork 一次。
- `parent_boundary_seq`：fork 时父会话里最后一条已完成轮次的消息的 `messages.surface_seq`。`surface_seq` 是 per-session 且永久不变的，可以直接当截断点。这个值无法事后推算——父之后继续跑，就再也无法知道 fork 那一刻哪个轮次正在进行——因此必须存储。
- fork 时刻父的最后一个压缩不落列，回放时推算：`compactions` 中 `session_id = 父`、`status = 'succeeded'` 且 `end_seq` 不超过 `parent_boundary_seq` 的最新一行。`end_seq` 是被压掉的最后一条消息的 `surface_seq`；fork 之后的新压缩，其 `end_seq` 必然超过边界，因而被排除，冻结语义自然成立。

边界取「最后一个已结束的轮次」：`turns.status` 不为 `running` 的最后一条消息。fork 发生在某一轮的工具执行中，正在跑的这一轮永远不进入继承范围。

## 3. 历史回放

### 3.1 优先级

`hist(session)` 返回该会话的完整消息数组，每个节点带 `origin_session_id`（这条消息属于哪个会话）。按以下顺序：

1. **本会话有压缩**（`compactions` 中 `seq` 最大的 `succeeded` 一行）：
   `[该压缩的 checkpoint 消息] + [本会话 surface_seq 大于该压缩终点的消息]`
2. **否则本会话有 `session_forks` 记录**：
   - 父存在可继承的压缩（按 §2 的规则推算）：`[该压缩的 checkpoint] + [父消息中 surface_seq 大于该压缩终点且不超过 parent_boundary_seq 的部分]`，再拼 `[本会话全部消息]`
   - 父无压缩：`hist(父)` 的祖先部分全部保留，父自己的消息截断到 `parent_boundary_seq`，再拼 `[本会话全部消息]`
3. **否则（普通会话）**：`[本会话全部消息]`

规则 1 命中后完全不再访问父会话：本会话的压缩已经把祖先内容吸收进摘要。

### 3.2 冻结

`parent_boundary_seq` 在 fork 时写死；父的压缩状态由它推算（§2）。父会话之后新增轮次、再次压缩，都不改变子会话看到的历史。

### 3.3 边界截断

- 只按 `surface_seq` 截断，不按消息 id：父与子的消息 id 在全局序列上交错，id 大小不能表示父的先后。
- 截断只作用于 `origin_session_id` 等于直接父的节点；`hist(父)` 里来自更上层祖先的部分无条件保留（继承段的祖先前缀全带）。

### 3.4 防环

fork 时校验：`parent_session_id` 不能是子会话自己，也不能是自己的后代。沿 `session_forks` 向上遍历祖先链，若遇到 `child_session_id` 则拒绝。

## 4. 压缩

### 4.1 输入

压缩的输入是 `hist(session)` 的完整结果，包含从祖先继承的全部内容。摘要因此可能覆盖父甚至祖父的历史。

### 4.2 边界

压缩终点只能落在本会话自己的消息上，不允许落在继承段。选择压缩边界时，只在 `origin_session_id` 等于本会话的节点里选。

### 4.3 产出

一次压缩写一行 `compactions`：`start_seq` / `end_seq` 记录区间，`summary_content_id` 记录摘要正文。是否吸收继承段不落列，由本会话是否存在 `session_forks` 记录推算；边界消息与所在轮次由 `end_seq` 在 surface 里定位。

### 4.4 回放语义

- 本会话有 `session_forks` 记录：摘要的起点是整条历史的开头，不是本会话第一条消息。`start_seq` 记 0，回放时忽略它，直接返回「摘要 + 本会话 `surface_seq` 大于 `end_seq` 的消息」。
- 本会话没有 `session_forks` 记录：替换本会话 `start_seq..end_seq` 范围内的节点。

## 5. 删除

- 软删（`deleted_at`）：不动 `session_forks`，历史仍可回放。
- 硬删：沿 `session_forks` 级联删除全部后代会话，后代的 turn / step / message 一并删除。

## 6. fork 工具

### 6.1 契约

工具注册为 `tools/subagent-fork/registry.json`，`name = subagent_fork`，参数与 `subagent` 相同（`cwd` / `description` / `prompt`）。

`description` 逐字采用 dsh 的 fork wording（来源 `dsh-tool-subagent/lib/index.js:337-341`）：

> Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps.

`prompt` 参数描述同源（`:342-345`）：

> The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new.

执行后立即返回 `started subagent <id>`，与 `subagent` 相同。

### 6.2 工具可见性

- `subagent`（spawn）：只在 `kind=normal` 的主会话可见，子会话不再 spawn。
- `subagent_fork`：所有会话可见。多层树靠它成立。

fork 出来的子会话与 spawn 的子会话共用同一套结算逻辑：结束时把结果作为一条 `role=user`、`source=subagent-settle` 的消息回灌父会话，并触发父的自动续轮。

## 7. 多层树

- 孙会话 fork 自子会话时，子会话若已有自己的压缩，孙直接继承该压缩；若没有，递归继承子的完整历史（可能含祖父）。
- 每层压缩都把祖先内容吸收进本层摘要，因此树的深度不增加回放成本：有压缩的会话只拼「自己的摘要 + 自己的后续消息」。
- 继承的祖先内容永远只读：子会话可以压缩它（吸收进摘要），但不能修改它。
