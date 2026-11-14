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
对应 UI `workspace` 下的 `session*` 节点，以及 `chat-viewport` 的 `chat-tab`。通过 `workspace_id` 关联工作区、`conf_id` 关联配置。`kind` 区分普通会话与子代理会话；子代理会话是同一 workspace 下另一条 sessions 行，拥有独立的序号序列与消息序列，并通过一次委派记录与其父会话关联。

```sql
CREATE TABLE sessions (
  id    integer      PRIMARY KEY,                          -- 会话唯一标识（自增整数）
  workspace_id  INTEGER     NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind  text    NOT NULL DEFAULT 'normal',            -- normal | subagent
  name  text    NOT NULL,                             -- 会话名
  description  text,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  -- 每次新增/修改消息时刷新
);
```

## session_seq_counters (会话序号计数)
per-session 序号分配器的缓存，不放业务表：`next_seq` 只增不减，保证序号不复用（删除消息后不回退）。`messages.surface_seq` 与 `compactions.seq` 共用这个序号空间。

```sql
CREATE TABLE session_seq_counters (
  session_id  integer  PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  next_seq    integer  NOT NULL DEFAULT 0
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
  surface_seq integer not null default 0,             -- per-session 序号，与 compactions.seq 共用
  role        text  NOT NULL,
  source      text,                                   -- 消息产生机制，见 enum source
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

enum source: [user_input, subagent-prompt, subagent-settle]

`source` 与 `role` 正交，表示消息由什么机制产生：`user_input` 是真人输入；`subagent-prompt` 是子会话首条消息（由父侧委派 tool_call 生成）；`subagent-settle` 是父会话里子代理结算产生的 user 消息。


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


## compactions (压缩记录)
一次压缩一行。`seq` 与 `messages.surface_seq` 共用同一个 per-session 序列，同时作为摘要节点（checkpoint）在 surface 里的序号；后续压缩可能以该节点为边界。

- 锁 = 同一 `boot` 内 `status = 'running'` 的记录；进程重启后旧 boot 的 running 自动失效。
- 失败也写一行（`status = 'failed'`），`error` 保留原因；surface 不变。
- 摘要正文存于 `contents`，经 `summary_content_id` 关联，存的是模型写的 8 段裸摘要；surface 回放时用 `frameCheckpoint()` 现拼 framed checkpoint（preamble + `<compacted-summary>` + 摘要 + 标签）再插入。
- `start_seq` / `end_seq` 是被压缩的第一条与最后一条消息的 `surface_seq`。切点是消息级的：边界可以落在 turn 内部（例如某个 step 的 tool result 之后），但必须是 tool-call/result 平衡的位置。
- 边界消息与所在轮次不落列，消费方按 `end_seq` 在 surface 里定位节点；是否吸收 fork 继承段由 `session_forks` 是否存在推算。
- 压缩概念与实现见 [context-compact.md](dev/context-compact.md)。

```sql
CREATE TABLE compactions (
  id                  integer  PRIMARY KEY,
  session_id          integer  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq                 integer  NOT NULL,      -- per-session 序号；摘要节点的 surface 序号
  start_seq           integer  NOT NULL,      -- 被压缩的第一条消息的 surface_seq
  end_seq             integer  NOT NULL,      -- 被压缩的最后一条消息的 surface_seq
  summary_content_id  integer  REFERENCES contents (id),
  trigger             text,                   -- manual | pressure | context-overflow
  provider            text,
  model               text,
  status              text     NOT NULL,      -- running | succeeded | failed
  error               text,
  boot                text,                   -- 进程身份；旧 boot 的 running 视为 stale
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  finished_at         TIMESTAMP,
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
2. 按 `seq` 顺序应用 `compactions` 中 `status = 'succeeded'` 的记录：
   删除 `start_seq..end_seq` 范围内的节点，在 start 位置插入摘要节点（该节点的 `seq` 取 `compactions.seq`）；
3. 结果就是模型可见的 surface（摘要 + 保留的尾部消息）。

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

## agent_subagents (子代理关联表)
```sql
create table subagents (
  sub_sess_id  integer NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  par_sess_id  integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  discarded_at TIMESTAMP
);
```

### subagent_prompts (子代理委派消息关联表)
message input by subagent-prompt <-> tool_call
```sql
create table subagent_prompts (
  call_id integer references calls(id),
  prompt_id integer references messages(id)
)
```

### subagent_settles (子代理回复消息关联表)
message output <-> message input by subagent-settle
```sql
create table subagent_settles (
  output_id integer references messages(id),
  settle_id integer references messages(id)
)
```

## session_forks (会话继承表)
fork 出来的子会话不复制父的历史，只记录继承到父的哪条消息为止。回放时递归拼接父的历史，压缩时把继承段吸收进本会话摘要。fork 时刻父的最后一个压缩由 `parent_boundary_seq` 推算（`compactions` 中 `status = 'succeeded'` 且 `end_seq` 不超过该值的最新一行），不落列。详见 `docs/dev/session-tree.md`。

```sql
create table session_forks (
  child_session_id     integer primary key,   -- 一个子会话只能 fork 一次
  parent_session_id    integer not null,
  parent_boundary_seq  integer not null,      -- 父会话最后一条已完成消息的 surface_seq
  created_at           timestamp not null default now()
)
```