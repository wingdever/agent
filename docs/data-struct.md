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
  role        text  NOT NULL,
  content_id  integer not null references contents (id) on delete cascade,
  thought_id  integer not null references contents (id) on delete cascade,    
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
