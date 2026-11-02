# mode-selector:
## bare-chat
if not select workspace
agent-loop: between user_input and model_reply
not save just in memory
not support tool_call 
continously interact
## turn-step
should select workspace
agent-loop: user_input start one turn and loop steps
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
        


