# A2A runtime

A2A is an **edge protocol adapter**, not a subagent provider. It sits beside
ACP: both expose the same `AgentRuntime.chat` to an external client, but each
has its own external contract. Internally a session remains the durable
conversation, a turn remains one model/tool loop, and a message remains a
surface row.

## Concept mapping

| A2A v1.0.1 | This project | Rule |
| --- | --- | --- |
| Agent / Remote Agent | A2A instance row + HTTP endpoint | Not `core.memory.Agent`; the latter is a per-session runtime instance. |
| Context | `a2a_contexts` | One context binds exactly one durable `sessions.id`. Never confuse with `core/context` (prompt assembly). |
| Task | `a2a_tasks` | A protocol-level unit that may span several internal turns. Not `turns`, `steps`, `team_tasks`, `jobs`, or `schedules`. |
| Message | `a2a_messages` + internal `messages` row | A2A message id is the idempotency key. The internal row is the transcript. |
| Part | JSON `parts` | The MVP accepts text only. `raw`/`url`/`data` are rejected instead of silently dropped. |
| Artifact | `a2a_tasks.artifacts` | Final text is an artifact, not the assistant message body. |
| Task state | `a2a_tasks.state` | Eight protocol states, not `turn.status` (pending/succeeded/failed). |
| AgentSkill | `a2a_instances.skills` | Advertised capability metadata. The MVP maps every skill to the same `chat` turn; it does not bind a skill to a prompt/tool whitelist yet. |
| SecurityScheme | HTTP Bearer at the edge | Not the local interaction/approval mechanism. |

Recommended identity mapping:

```text
A2A context 1 ── 1 internal session
A2A task    1 ── N internal turns
A2A message 1 ── 1 internal user message
A2A artifact 1 ─ N internal assistant contents / file outputs
```

The MVP serializes one active task per context. A second `SendMessage` for a
context with an active task is rejected with `-32003`; clients should wait for
`GetTask` or `CancelTask`.

## Storage

The A2A domain has its own tables so protocol retries and state survive a
restart:

```sql
a2a_instances   -- endpoint config + advertised skills
a2a_contexts    -- context_id -> session_id
a2a_tasks       -- task state, input, artifacts, revision
a2a_messages    -- message_id (unique), task_id, role, parts
```

`a2a_messages.message_id` is unique. `SendMessage` looks it up before creating
a task, so a retried request returns the original task instead of starting a
second turn.

## Endpoints

One instance is mounted at:

```text
GET  /a2a/:instanceId/agent-card.json
GET  /.well-known/agent-card.json
POST /a2a/:instanceId
```

The POST endpoint is JSON-RPC 2.0. Supported methods:

- `SendMessage` (returns `{ task }`; `configuration.returnImmediately` is honored)
- `GetTask` (returns `{ task }`)
- `CancelTask` (returns `{ task }`)
- `ListTasks` (returns `{ tasks }`)
- `GetExtendedAgentCard`

Not implemented: `SendStreamingMessage`, `SubscribeToTask`, push notifications.
The AgentCard advertises `streaming: false`.

## State machine

| Trigger | State |
| --- | --- |
| `SendMessage` creates a task | `TASK_STATE_SUBMITTED` |
| internal turn starts | `TASK_STATE_WORKING` |
| turn ends successfully | `TASK_STATE_COMPLETED` + artifact |
| turn ends failed or throws | `TASK_STATE_FAILED` |
| `CancelTask` / `agent.interrupt()` | `TASK_STATE_CANCELED` |
| invalid skill/params | JSON-RPC `-32602`; `TASK_STATE_REJECTED` is reserved for a future policy-level refusal |
| `ask_user_question` | **not mapped in MVP**; the edge answers empty so the turn can finish. `INPUT_REQUIRED` is reserved for a future resumable-question path. |
| tool approval pending | policy `deny` by default; policy `allow` approves once. Never `AUTH_REQUIRED`. |
| bad token | HTTP 401, not a task state |

`CancelTask` is a CAS update. If the turn later returns success, the settle path
observes `TASK_STATE_CANCELED` and keeps it canceled.

## Running

```bash
pnpm run a2a
# or
node a2a-server.js --instance=default --host=127.0.0.1 --port=8787 --workspace=/path/to/project
```

Bearer auth is enabled by `A2A_TOKEN` (or `--token`). The AgentCard remains
public; the JSON-RPC endpoint requires `Authorization: Bearer <token>` when a
token is configured. `--approval-policy=deny|allow` controls tool approvals for
A2A tasks; `allow` is intended only for trusted local agents.

Outbound calls use the `a2a_call` tool. It fetches a remote AgentCard, sends one
text message with `returnImmediately`, polls `GetTask`, and returns artifact
text. It is stateless: `card_url` is supplied per call. `token_env` names an
environment variable so tokens never enter model arguments.

## Known limits

- Text parts only.
- One active task per context; no queue.
- No SSE, push notifications, or resumable `INPUT_REQUIRED`.
- No multi-instance UI/config file yet; instance config is created by the
  standalone entry.
- No SSRF allowlist, rate limit, or audit log yet. Bind to localhost by default.
- `a2a_skills` does not bind prompts or tool whitelists; all skills execute the
  same `chat` path.
