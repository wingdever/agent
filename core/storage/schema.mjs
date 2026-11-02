// 数据持久化 DDL —— 真值来源：docs/data-struct.md
// 适配说明（pgmicro 约束）：
//   1. TIMESTAMP 默认值用 now() 代替 CURRENT_TIMESTAMP（pgmicro 不支持后者作为列默认值）
//   2. calls.arguments 为保留字，SQL 中统一双引号引用
//   3. 主键为 integer（非 SERIAL），ID 由应用层分配
//   4. pgmicro 的 exec 仅执行单条语句，故此处导出语句数组，由 store 逐条执行

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id            integer  PRIMARY KEY,
    folder_path   text NOT NULL UNIQUE,
    folder_name   text NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT now(),
    updated_at    TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_updated ON workspaces (updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS providers (
    id integer primary key,
    name text not null default 'qiniu',
    description text,
    baseurl text,
    apikey text,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS models (
    id integer primary key,
    provider_id integer not null references providers(id) on delete cascade,
    name text not null default 'conatus-free',
    description text,
    fee text default 'free',
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS tools (
    id    integer      PRIMARY KEY,
    name  text not null unique,
    description  text not null,
    schema_json  text not null,
    path  text,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS skills (
    id    integer      PRIMARY KEY,
    name  text,
    description  text,
    prompt TEXT,
    path  text,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS tool_skills (
    tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    PRIMARY KEY (tool_id, skill_id)
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id    integer      PRIMARY KEY,
    workspace_id  INTEGER     NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name  text    NOT NULL,
    description  text,
    created_at    TIMESTAMP NOT NULL DEFAULT now(),
    updated_at    TIMESTAMP NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS turns (
    id          integer PRIMARY KEY,
    session_id  INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    seq  integer not null,
    status text not null default 'pending',
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now(),
    unique (session_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS steps (
    id integer PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
    seq  integer not null,
    status text not null default 'pending',
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now(),
    unique (turn_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS contents (
    id          integer PRIMARY KEY,
    content     text  NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id          integer PRIMARY KEY,
    step_id     INTEGER NOT NULL REFERENCES steps (id) ON DELETE CASCADE,
    seq         integer not null,
    role        text  NOT NULL,
    content_id  integer references contents (id) on delete cascade,
    thought_id  integer references contents (id) on delete cascade,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now(),
    unique(step_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS calls (
    id          integer PRIMARY KEY,
    reply_id    INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    seq         integer not null,
    call_id     text,
    name        text  NOT NULL,
    "arguments"   text,
    description text,
    status      text not null default 'pending',
    result_id   integer REFERENCES contents (id),
    error       text,
    category    text not null,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now(),
    unique (reply_id, seq)
  )`,

  // One current goal per session (the DSH model keeps goal history; this dev
  // project only needs the live value plus CAS revision).
  `CREATE TABLE IF NOT EXISTS goals (
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
  )`,
];
