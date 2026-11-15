nettrack: capture LLM request/response.
moved out of root nettrack/ into core/network/http/ (client.js + tracker.js).
_ post (https.request, chat/completions) and fetch (fetchModels, /models) both tee through tracker.

turn: one stdout line per finished turn, printed by AgentCore.chat().
[turn] session=… turn=… status=… reason=… steps=… tools=… duration=…ms [error=…]
reasons: no-tool-calls | truncated | empty-response | model-request-error | unexpected-exception.
