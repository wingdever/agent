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
    while step < MAX_STEPS:               -- step
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
        


