1. when update database schema just rm db file instead of update.
2. not edit files data-struct.md and ui.md except let you do so.
3. use english for code especially hardcode name and description.

4. nettrack (network request/response capture) requirements (2026-11-02):
   - implementation code lives in core/network/http/ (NOT a standalone package at repo root, NOT core/network/track/). tracker.js sits inside core/network/http/.
   - the http client (core/network/http/client.js) performs the LLM calls and tees each response stream into tracker.js.
   - captured data is saved as JSON files (one file per capture), NOT JSONL.
   - captured data path: log/network/track/data/<provider>/<model>/<sessionId>-<timestamp>.json (provider = baseUrl hostname).
   - when launched from the CLI, core prints a one-line summary of every network call (method, host/path, model, status, duration). capture is ON by default; NETTRACK=0 disables; NETTRACK_QUIET=1 silences the per-call print.
   - before implementing, grill the need/situation first and only build after the user checks ok.
