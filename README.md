# agent

A micro AI agent aims to help learn harness engineer. 

## Quick Start

### commands

```bash
npm install          # install dependencies (includes electron 44.9.3)
npm start            # launch the default electron UI + http transport
npm test             # run tests
```

### environment-variables

```bash
AGENT_UI=electron 
AGENT_TRANSPORT=http
```

- `AGENT_UI`: 
which UI implementation to use. 
Currently registered: `electron` (default).
- `AGENT_TRANSPORT`: 
how the core communicates with the UI. 
Supports `http` (default) and `ipc`.


## Architecture

Three layers — core / transport / UI — are separated. 
Business logic lives in the core; the UI only renders. 
This makes it easy to replace or add a client.

```tree
agent/
├── launcher.js           coordinator: picks UI and starts transport
├── core/                 core: business logic
│   ├── index.js         createCore() entry point
│   ├── transport.js     transport registry
│   ├── transports/      http.js / ipc.js
│   ├── tools/           core-side tool support
│   ├── storage/         session / data persistence
│   └── system-prompt.js
├── tools/                pluggable tools
├── ui/
│   ├── electron/        electron client (main.js / preload.js)
│   └── web/             renderer (app.js / index.html / styles.css)
└── docs/                 design and impl docs
```

### Tools

Each subdirectory under `tools/` is a standalone tool.
A tool declares its own interface by `registry.json`.


### Context compaction

DSH-style context compression. `/compact` condenses older history into one structured
checkpoint message on demand; automatic pressure compaction runs before every model
request once the context reaches 80% of the window (prune oversized tool results first).
Original messages stay in storage; the model-visible history is projected from them.

Implementation details: [docs/context-compact.md](docs/context-compact.md).
Background on event sourcing and DSH's log/surface split: [docs/event-sourcing.md](docs/event-sourcing.md).

### Configuration

now config files in `user/` includes:
basic `settings.json`, `providers.json`;
permit `permissions.json`, `bash-policy.json`, `fs-policy.json`


## License

GNU General Public License v3.0 — see `LICENSE`.
