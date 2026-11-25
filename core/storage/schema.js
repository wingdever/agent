// 数据持久化 DDL —— 真值来源：docs/foundation/storage/schema.md
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
    kind  text    NOT NULL DEFAULT 'normal',  -- normal | subagent
    name  text    NOT NULL,
    description  text,
    activity  text  NOT NULL DEFAULT 'research',
    deleted_at   TIMESTAMP,
    created_at    TIMESTAMP NOT NULL DEFAULT now(),
    updated_at    TIMESTAMP NOT NULL DEFAULT now()
  )`,

  // per-session 序号分配器的缓存。next_seq 只增不减，保证序号不复用；
  // messages.surface_seq 与 compactions.seq 共用这个序号空间。
  `CREATE TABLE IF NOT EXISTS session_seq_counters (
    session_id  integer  PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    next_seq    integer  NOT NULL DEFAULT 0
  )`,

  // fork 继承：子会话不复制父历史，只记录继承到父的哪条消息为止。
  // 回放时按父会话的 compactions 与 parent_boundary_seq 拼接继承段。
  `CREATE TABLE IF NOT EXISTS session_forks (
    child_session_id     integer  PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    parent_session_id    integer  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    parent_boundary_seq  integer  NOT NULL,   -- 父会话最后一条已完成消息的 surface_seq
    created_at           TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_forks_parent ON session_forks (parent_session_id)`,

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
    surface_seq integer not null default 0,  -- per-session 序号，与 compactions.seq 共用
    role        text  NOT NULL,
    source      text,                          -- 消息产生机制: user_input | subagent-prompt | subagent-settle | agent-message
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

  // 压缩记录：一次压缩一行。seq 与 messages.surface_seq 共用同一个 per-session
  // 序列，同时作为摘要节点（checkpoint）在 surface 里的序号。锁 = 同一 boot 内
  // status='running' 的行；进程重启后旧 boot 的 running 自动失效。
  // 摘要正文存于 contents（summary_content_id），surface 回放时现拼 framed checkpoint。
  `CREATE TABLE IF NOT EXISTS compactions (
    id                  integer  PRIMARY KEY,
    session_id          integer  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    seq                 integer  NOT NULL,
    start_seq           integer  NOT NULL,   -- 被压缩的第一条 surface 节点 seq
    end_seq             integer  NOT NULL,   -- 被压缩的最后一条 surface 节点 seq
    summary_content_id  integer  REFERENCES contents (id),
    trigger             text,                -- manual | pressure | context-overflow
    provider            text,
    model               text,
    status              text     NOT NULL,   -- running | succeeded | failed
    error               text,
    boot                text,
    created_at          TIMESTAMP NOT NULL DEFAULT now(),
    finished_at         TIMESTAMP,
    unique (session_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions (session_id, seq)`,

  // Token-meter usage anchor (DSH tokenMeter anchor): the latest successful
  // request's canonical header, the surface price at that request, and the
  // provider-reported usage. Measure() reuses usage while the header matches
  // and applies the signed surface delta on top.
  `CREATE TABLE IF NOT EXISTS token_anchors (
    session_id        integer  PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    header_key        text     NOT NULL,
    header_tokens     integer  NOT NULL,
    input_tokens      integer  NOT NULL,
    assistant_tokens  integer  NOT NULL,
    usage_total       integer  NOT NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP NOT NULL DEFAULT now()
  )`,

  // Deterministic tool-result pruning: the original message row stays intact,
  // and history assembly substitutes the pruned text. Mirrors DSH's
  // compaction-tool-result-pruner defaults (8192 / 4096 / 1024 code points).
  `CREATE TABLE IF NOT EXISTS tool_result_prunes (
    message_id   integer  PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    content      text     NOT NULL,
    chars_before integer  NOT NULL,
    chars_after  integer  NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT now()
  )`,

  // User jobs: tasks the model delegates to the human user via request_user_job.
  // The model-facing lifecycle mirrors DSH's job_* (create -> output/list/kill),
  // but there is no background process — the user completes the task in the real
  // world and reports back through an interactive card. status is one of
  // 'pending' | 'completed' | 'killed'.
  `CREATE TABLE IF NOT EXISTS user_jobs (
    id            integer  PRIMARY KEY,
    job_id        text     NOT NULL UNIQUE,
    session_id    integer  REFERENCES sessions (id) ON DELETE CASCADE,
    status        text     NOT NULL DEFAULT 'pending',
    description   text     NOT NULL,
    title         text,
    result        text,
    created_at    TIMESTAMP NOT NULL DEFAULT now(),
    updated_at    TIMESTAMP NOT NULL DEFAULT now()
  )`,

  // Background jobs owned by the agent runtime: a tool starts work, returns a
  // job id immediately, and the completion notice arrives in the session later.
  // Unlike user_jobs (tasks delegated to the human), these carry a real
  // in-process run. status is 'running' | 'completed' | 'failed' | 'killed';
  // output is the tail of the observation stream, persisted at settle time.
  `CREATE TABLE IF NOT EXISTS jobs (
    id          integer  PRIMARY KEY,
    job_id      text     NOT NULL UNIQUE,
    session_id  integer  REFERENCES sessions (id) ON DELETE CASCADE,
    kind        text     NOT NULL,
    label       text,
    status      text     NOT NULL DEFAULT 'running',
    detail      text,
    result      text,
    output      text,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    started_at  TIMESTAMP NOT NULL DEFAULT now(),
    finished_at TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs (session_id, created_at DESC)`,
  // Which process owns a running job. Kept in a side table because pg-micro
  // rewrites a table's CREATE statement on ALTER TABLE and drops the dialect
  // marker, which makes the next open fail (`DEFAULT now()` is not portable).
  // Two processes (desktop + channel daemon) may share the same store file.
  `CREATE TABLE IF NOT EXISTS job_owners (
    id          integer  PRIMARY KEY,
    job_id      text     NOT NULL UNIQUE,
    pid         integer,
    boot        text,
    created_at  TIMESTAMP NOT NULL DEFAULT now()
  )`,

  // Agent Team task board. One board per subagent-tree root (`team_id` is the
  // root session id); members do not get a second membership table.
  // A row is a whole task snapshot; every mutation increments revision, and
  // store-level CAS rejects stale writes. Deleted rows stay as tombstones.
  `CREATE TABLE IF NOT EXISTS team_tasks (
    id           integer  PRIMARY KEY,
    team_id      integer  NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq          integer  NOT NULL,
    task_id      text     NOT NULL,
    revision     integer  NOT NULL DEFAULT 1,
    subject      text     NOT NULL,
    description  text     NOT NULL,
    status       text     NOT NULL DEFAULT 'pending',
    owner_id     integer,
    owner_name   text,
    blocked_by   text     NOT NULL DEFAULT '[]',
    write_scopes text     NOT NULL DEFAULT '[]',
    created_at   TIMESTAMP NOT NULL DEFAULT now(),
    updated_at   TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_tasks_id ON team_tasks (team_id, task_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_tasks_seq ON team_tasks (team_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_team_tasks_status ON team_tasks (team_id, status)`,

  // ---- Host-level scheduled tasks ----
  // One row is one complete schedule snapshot. `timing` and `target` are JSON;
  // `next_at` is the committed next occurrence, not a projection of the rule.
  // `revision` is the CAS version used by schedule_edit and delivery commits.
  `CREATE TABLE IF NOT EXISTS schedules (
    id            integer  PRIMARY KEY,
    seq           integer  NOT NULL UNIQUE,
    schedule_id   text     NOT NULL UNIQUE,
    title         text     NOT NULL,
    prompt        text     NOT NULL,
    timing        text     NOT NULL,
    target        text     NOT NULL,
    status        text     NOT NULL DEFAULT 'active',
    next_at       TIMESTAMP NOT NULL,
    last_delivery text,
    revision      integer  NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT now(),
    updated_at    TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (status, next_at)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_updated ON schedules (updated_at DESC)`,

  // Subagent delegation: parent/sub session link; agent_name is the model-side
  // name, unique among siblings; discarded_at marks an undeliverable settlement
  // (see docs/subagent/subagent.md §6.4).
  // delivery is the result policy fixed at creation: 'parent' posts a settlement
  // notice to the parent conversation, 'caller' leaves the result to whoever
  // started the child. It is persisted so a released-then-woken child keeps the
  // same policy, independent of whether its instance is resident.
  `CREATE TABLE IF NOT EXISTS subagents (
    sub_sess_id  integer NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    par_sess_id  integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_name   text    NOT NULL,
    delivery     text    NOT NULL DEFAULT 'parent',
    discarded_at TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subagents_name ON subagents (par_sess_id, agent_name)`,

  // Delegation tool_call <-> first user message in the child session.
  `CREATE TABLE IF NOT EXISTS subagent_prompts (
    call_id   integer REFERENCES calls(id),
    prompt_id integer REFERENCES messages(id)
  )`,

  // Child's final output message <-> settlement user message in the parent session.
  `CREATE TABLE IF NOT EXISTS subagent_settles (
    output_id integer REFERENCES messages(id),
    settle_id integer REFERENCES messages(id)
  )`,

  // ---- Flows: user-edited node graphs and their executions ----
  // A flow is data: nodes, edges and layout in one JSON document. The runtime
  // never reads it back into code; it walks it as a graph (docs/flow/flow.md).

  `CREATE TABLE IF NOT EXISTS flows (
    id          integer PRIMARY KEY,
    name        text    NOT NULL,
    description text,
    definition  text    NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
  )`,

  // One row per execution. `status` is running | succeeded | failed | cancelled.
  `CREATE TABLE IF NOT EXISTS flow_runs (
    id         integer PRIMARY KEY,
    flow_id    integer NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    status     text    NOT NULL DEFAULT 'running',
    input      text,
    output     text,
    error      text,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now(),
    ended_at   TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs (flow_id, created_at DESC)`,

  // One row per node execution within a run; `seq` orders a node's revisit.
  `CREATE TABLE IF NOT EXISTS flow_node_runs (
    id        integer PRIMARY KEY,
    run_id    integer NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
    node_id   text    NOT NULL,
    node_type text    NOT NULL,
    seq       integer NOT NULL,
    status    text    NOT NULL,
    input     text,
    output    text,
    error     text,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flow_node_runs_run ON flow_node_runs (run_id, id)`,

  // ---- A2A protocol domain ----
  // The A2A Task/Context is a protocol-level contract, not an alias for
  // sessions/turns. A context binds one external contextId to one durable
  // session; a task can span several internal turns.
  `CREATE TABLE IF NOT EXISTS a2a_instances (
    id           integer  PRIMARY KEY,
    instance_id  text     NOT NULL UNIQUE,
    name         text     NOT NULL,
    description  text,
    version      text     NOT NULL DEFAULT '0.1.0',
    workspace_id integer  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    skills         text     NOT NULL DEFAULT '[]',
    token_env      text,
    approval_policy text    NOT NULL DEFAULT 'deny',
    enabled      integer  NOT NULL DEFAULT 1,
    created_at   TIMESTAMP NOT NULL DEFAULT now(),
    updated_at   TIMESTAMP NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS a2a_contexts (
    id          integer  PRIMARY KEY,
    context_id  text     NOT NULL UNIQUE,
    instance_id text     NOT NULL,
    session_id  integer  NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_contexts_session ON a2a_contexts (session_id)`,

  `CREATE TABLE IF NOT EXISTS a2a_tasks (
    id             integer  PRIMARY KEY,
    task_id        text     NOT NULL UNIQUE,
    context_id     text     NOT NULL,
    session_id     integer  NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    instance_id    text     NOT NULL,
    skill          text     NOT NULL DEFAULT 'chat',
    state          text     NOT NULL DEFAULT 'TASK_STATE_SUBMITTED',
    status_message text,
    last_message_id text,
    input          text,
    artifacts      text     NOT NULL DEFAULT '[]',
    error          text,
    revision       integer  NOT NULL DEFAULT 1,
    created_at     TIMESTAMP NOT NULL DEFAULT now(),
    updated_at     TIMESTAMP NOT NULL DEFAULT now(),
    finished_at    TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks (context_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_tasks_state ON a2a_tasks (state)`,

  `CREATE TABLE IF NOT EXISTS a2a_messages (
    id          integer  PRIMARY KEY,
    message_id  text     NOT NULL UNIQUE,
    task_id     text     NOT NULL,
    role        text     NOT NULL,
    parts       text     NOT NULL DEFAULT '[]',
    created_at  TIMESTAMP NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_messages_task ON a2a_messages (task_id)`,
];
