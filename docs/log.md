nettrack: capture LLM request/response.
moved out of root nettrack/ into core/network/http/ (client.js + tracker.js).
_ post (https.request, chat/completions) and fetch (fetchModels, /models) both tee through tracker.
