# mode-selector (session mode layer: bare / persisted)
`core.chat()` 先在**选择 loop engine 之前**按**显式信号** `ctx.mode === "bare"` 分发：命中 → bare，否则 → persisted。bare 是会话模式，不是 activity，也不是 `AGENT_LOOP_ENGINE` 的取值（不进 `core/loops/` 注册表）。
判定用显式 `mode` 而非 `!sessionId`：`persist = sessionId && store` 只控制落库，工具执行与 sessionId 无关；存在无 sessionId 但需完整工具循环的合法调用方，不能用「无会话」推断 bare。UI 的 `runBareChat` 显式传 `mode:"bare"`。

## bare (bare-chat)
if caller explicitly passes mode:"bare" (UI: not select session/workspace)
entry: core/bare-chat.js runBareChat() — NOT a loop engine
no persistence: not save, history kept in memory only (bareHistory, UI passes full messages)
no tool_call: tools=[] hard-forced by core (does not rely on UI passing toolNames:[])
system prompt assembled per request (no DB read, no cache, not shown)
still does input/output translation + linear termination/[turn] log/turn-end contract (steps=1, tools=0)
continously interact (flat render via onChatEventFlat)
## persisted (turn-step)
should select session/workspace (sessionId present)
agent-loop: user_input start one turn and loop steps
loop engine chosen ONLY in this branch: AGENT_LOOP_ENGINE -> linear / node-graph
save in database
support tool_call
continously interact
request-time: aftern finish all tool-call then request model

# model-selector
when no model supply or select use model in user/providers.json

-- session-loop
while has_next_user_input():              -- turn
    history.append(user_message())
    step = 0
    while true:               -- step
        response = request(history)       -- 每次都要重新请求
        history.append(response.message)  

        if response.tool_calls is empty:
            break                         -- 本 turn 结束

        for call in response.tool_calls:
            if approve(call):
                result = call()
            else:
                result = "refuse"
            history.append(tool_result(call.provider_call_id, result))
        step += 1

# turn termination
The step loop is unbounded (same as DSH's agent loop): it continues while the
model keeps returning tool_calls, and only the model ending its tool use (or an
abnormal end) closes the turn. There is no hard-coded step cap.

Every turn end leaves exactly one log line:

    [turn] session=… turn=… status=… reason=… steps=… tools=… duration=…ms

reason is one of:

| reason | status | meaning |
| --- | --- | --- |
| `no-tool-calls` | succeeded | normal end: the model returned content and no tool_calls |
| `truncated` | failed | `finish_reason=length`: the response was cut off |
| `empty-response` | failed | no content and no tool_calls |
| `model-request-error` | failed | the model request itself failed |
| `unexpected-exception` | failed | anything else thrown while running the turn |

Abnormal ends emit `turn-end {status, reason, steps, tools, durationMs, error}`
instead of `done`, so a failed turn is never rendered as an answer.
        


