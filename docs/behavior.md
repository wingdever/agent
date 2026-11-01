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