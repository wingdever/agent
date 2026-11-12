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


### Configuration

now config files in `user/` includes:
basic `settings.json`, `providers.json`;
permit `permissions.json`, `bash-policy.json`, `fs-policy.json`


## Module design

Two commitments define the module layer's design:

- **Module = runtime capability package.** Modules are decoupled at compile time and joined at runtime through a registry. 
- **Observability is a baseline module-design rule, not a standalone feature.** 
Every module emits observable signals by default — spans / trajectory / cost / latency metrics. 
This is a fundamental design guideline for modules rather than an optional add-on.


## License

GNU General Public License v3.0 — see `LICENSE`.
