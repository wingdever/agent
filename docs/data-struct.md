# 数据结构设计

支撑会话树与聊天消息持久化。
采用pgmicro作为数据库引擎。
存储路径:"./data/store.db"

树状关系:
workspaces[sessions[turns[steps[messages[]]]]]
  

## workspaces（工作区）

```sql
-- 工作区表
CREATE TABLE workspaces (
  id            integer  PRIMARY KEY,  -- 路径会变，不拿路径当主键
  folder_path   text NOT NULL UNIQUE,  -- 工作区根目录绝对路径（移动/重命名时同步刷新）
  folder_name   text NOT NULL,         -- 展示名（侧栏 workspace 节点标题）
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- 侧栏按最近更新排序用
CREATE INDEX idx_workspaces_updated ON workspaces (updated_at DESC);
```

## providers (供应者)
```sql
create table providers (
  id integer primary key,
  name text not null default 'qiniu',
  description text,
  baseurl text,
  apikey text,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## models (模型)
```sql
create table models (
  id integer primary key,
  provider_id integer not null references providers(id) on delete cascade,
  name text not null default 'conatus-free',
  description text,
  fee text default 'free',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## tools (工具)
```sql
CREATE TABLE tools (
  id    integer      PRIMARY KEY,
  name  text not null unique,
  description  text not null,
  schema_json  text not null,
  path  text,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## skills (技能)
```sql
CREATE TABLE skills (
  id    integer      PRIMARY KEY,
  name  text,
  description  text,
  prompt TEXT,
  path  text,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## tool_skills (工具与技能关联表)
```sql
CREATE TABLE tool_skills (
  tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (tool_id, skill_id)
);
```


## sessions（会话）
对应 UI `workspace` 下的 `session*` 节点，以及 `chat-viewport` 的 `chat-tab`。通过 `workspace_id` 关联工作区、`conf_id` 关联配置。

```sql
CREATE TABLE sessions (
  id    integer      PRIMARY KEY,                          -- 会话唯一标识（自增整数）
  workspace_id  INTEGER     NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name  text    NOT NULL,                             -- 会话名
  description  text,
  next_seq integer NOT NULL DEFAULT 0,                -- per-session 事件序列（messages + session_events）
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  -- 每次新增/修改消息时刷新
);
```


## turns (轮次)
```sql
create table turns (
  id          integer PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq  integer not null,
  status text not null default 'pending', 
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unique (session_id, seq)
);
```

enum status: [pending,running,succeeded,failed,canceled]


## steps (步骤)
一般每个步骤包含一次向大模型的请求和一个大模型返回的响应。
每个请求可能包含多个消息。
```sql
create table steps (
  id integer PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
  seq  integer not null,
  status text not null default 'pending', 
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unique (turn_id, seq)
);
```

enum step_status ('pending', 'running', 'succeeded', 'failed', 'canceled');


## contents (内容)
```sql
create table contents  (
  id          integer PRIMARY KEY,
  content     text  NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## messages (消息)
```sql
create table messages  (
  id          integer PRIMARY KEY,
  step_id     INTEGER NOT NULL REFERENCES steps (id) ON DELETE CASCADE,
  seq         integer not null,
  surface_seq integer not null default 0,             -- per-session 事件序列，与 session_events.seq 共用
  role        text  NOT NULL,
  content_id  integer references contents (id) on delete cascade,
  thought_id  integer references contents (id) on delete cascade,    
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unique(step_id, seq)
);
```

enum role: [user,system,assistant,tool]
role and type:
user - user_input
system - system_prompt
assistant - model_reply
tool - tool_result


## calls (工具调用)
```sql
create table calls (
  id          integer PRIMARY KEY,
  reply_id    INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  seq         integer not null,
  call_id     text, -- assigned by model reply
  name        text  NOT NULL,
  arguments   text,
  description text,
  status      text not null default 'pending',
  result_id   integer REFERENCES contents (id),
  error       text,
  category    text not null,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unique (reply_id, seq)
);
```

enum name: [text_read,text_write,text_edit,text_grep,file_touch,file_remove,file_stat,dir_mkdir,dir_rmdir,dir_list,shell_run,python_run,sql_insert,sql_delete,sql_select,sql_update,web_search,web_fetch...]
enum category: [textfile,bash,sql,script,web]


## session_events (压缩事件日志)
按 DSH 的格式记录压缩事务；`seq` 与 `messages.surface_seq` 共用同一个 per-session 序列，
因此 `shadowedSeqs` 与 `surfaceOp` 范围都是真实的事件序号。

事件序列（一次成功压缩）：
`compaction/start` → `compaction/summary` → `user/message`(surfaceOp: replace) → `compaction/end`

- 锁 = 同一 `boot` 内未闭合的 `compaction/start`；进程重启后旧 boot 的 start 自动失效
  （等价 DSH 的 `session/end-seed` 边界）。
- 失败也写 `compaction/end`，`data.error` 保留原因；没有 summary 与 replace 事件，surface 不变。
- `compaction/summary` 带 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount` /
  `tokensAfter` / `provider` / `model` / `turns` / `boundaryMessageId` / `boundaryTurnSeq`。
- `user/message` 事件带 `content`（framed checkpoint）、`source`（plugin/compact/compactionId）、
  `surfaceOp`（replace 起止 seq）、`sourceEventSeqs`。

概念区分：`compaction/summary.data.summary` 是模型写的 8 段正文；`user/message.data.content`
是 framed checkpoint（preamble + `<compacted-summary>` + summary + 标签）；surface 上的是后者，
summary 只在日志/审计/UI 正文里使用。事件回放与概念背景见
[context-compact.md](context-compact.md) 与 [event-sourcing.md](event-sourcing.md)。

```sql
CREATE TABLE session_events (
  id          integer  PRIMARY KEY,
  session_id  integer  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq         integer  NOT NULL,
  type        text     NOT NULL,   -- compaction/start | compaction/summary | user/message | compaction/end
  data        text     NOT NULL,   -- JSON payload
  boot        text,                -- 进程身份；旧 boot 的未闭合 start 视为 stale
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  unique (session_id, seq)
);
```

## token_anchors (token 计量锚点)
DSH token-meter 的 usage 锚点：最近一次成功请求的 canonical header、请求时的 surface 价格、
provider 上报的 usage。header 不变时，`measure()` 用 `usage + (当前 surface - 锚定 surface)`
计算压力；header 变化（模型/system/tools）则整包重新估价。

```sql
CREATE TABLE token_anchors (
  session_id        integer  PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  header_key        text     NOT NULL,   -- sha1(model + system + tools)
  header_tokens     integer  NOT NULL,
  input_tokens      integer  NOT NULL,   -- 请求时 surface（messages）的启发式价格
  assistant_tokens  integer  NOT NULL,   -- 该次回复的输出估价
  usage_total       integer  NOT NULL,   -- provider usage 总额；缺失时等于估价
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);
```

## tool_result_prunes (工具结果裁剪)
模型无关的确定性裁剪：只记录替换体，原始 `messages`/`contents` 不变；历史投影时用
`tool_result_prunes.content` 取代对应 tool 消息。默认参数沿用 DSH pruner
（threshold 8192 / head 4096 / tail 1024 code points）。

```sql
CREATE TABLE tool_result_prunes (
  message_id   integer  PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  content      text     NOT NULL,
  chars_before integer  NOT NULL,
  chars_after  integer  NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);
```

## 历史投影（surface replay）
请求不再由前端整包拼历史，而是 core 每次从存储回放 surface：

1. 读取全部 messages（按 turn/step/msg 顺序），跳过 system，得到 append-origin 节点；
   assistant 的 `tool_calls` 从 `calls` 表还原，tool 消息按同 step 内顺序配对 `call_id`；
   tool 消息若在 `tool_result_prunes` 有替换体，则用替换体；
2. 按 `seq` 顺序应用 `session_events` 中的 `user/message` replace：
   删除 `surfaceOp.start..end` 范围内的节点，在 start 位置插入 checkpoint 节点；
3. 结果就是模型可见的 surface（checkpoint + 保留的尾部消息）。

压缩切点是**消息级**的：边界可以落在 turn 内部（例如某个 step 的 tool result 之后），
但必须是 tool-call/result 平衡的位置。UI 仍按 turn/step 渲染全部原始消息（append-origin transcript）。


## goals (目标)
```sql
CREATE TABLE goals (
  session_id       integer  PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  goal_id          text     NOT NULL,
  revision         integer  NOT NULL,
  objective        text     NOT NULL,
  phase            text     NOT NULL,
  rounds_started   integer  NOT NULL DEFAULT 0,
  max_goal_rounds  integer  NOT NULL,
  blocked_code     text,
  blocked_message  text,
  activation       text     NOT NULL DEFAULT 'armed',
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
)
```

## user_jobs (用户任务表)
```sql
CREATE TABLE user_jobs (
  id            integer  PRIMARY KEY,
  job_id        text     NOT NULL UNIQUE,
  session_id    integer  REFERENCES sessions (id) ON DELETE CASCADE,
  status        text     NOT NULL DEFAULT 'pending',
  description   text     NOT NULL,
  title         text,
  result        text,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP NOT NULL DEFAULT now()
)
```
