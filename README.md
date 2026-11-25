# agent

A micro AI agent aims to help learn harness engineer. 

## Quick Start

### commands

```bash
pnpm install         # install dependencies (includes electron 44.9.3)
pnpm start           # launch the default electron UI + http transport
```

`node-pty` builds a small native module during install. On Linux this needs
`python3`, `make` and `g++`; `node-gyp` is included as a dev dependency.

### environment-variables

```bash
AGENT_UI=electron
AGENT_TRANSPORT=http
AGENT_LOOP_ENGINE=node-graph
AGENT_TOOL_PROVIDER_BASH=persistent
AGENT_BASH_TERMINAL_BACKEND=pty
```

- `AGENT_UI`: 
which UI implementation to use. 
Currently registered: `electron` (default).
- `AGENT_TRANSPORT`: 
how the core communicates with the UI. 
Supports `http` (default) and `ipc`.
- `AGENT_LOOP_ENGINE`: 
which agent-loop engine to use. 
`node-graph` is the default and active engine; `linear` is frozen as a reference.
- `AGENT_TOOL_PROVIDER_BASH`:
selects the provider for the `bash` tool slot. `persistent` (default) keeps
cwd and exported environment across calls; `foreground` keeps the one-shot
`bash -c` behavior. Exactly one provider is registered.
- `AGENT_BASH_TERMINAL_BACKEND`:
selects the persistent bash transport. `pty` (default) uses `node-pty` so the
shell has a controlling terminal; `pipe` keeps the dependency-free fallback
with separate stdout/stderr. If `node-pty` cannot load, persistent bash falls
back to `pipe` automatically.


## Architecture

Three layers — core / transport / UI — are separated. 
Business logic lives in the core; the UI only renders. 
This makes it easy to replace or add a client.

```tree
agent/
├── launcher.js           coordinator: picks UI and starts transport
├── core/                 agent runtime: loops, context, tools, storage
│   ├── index.js          createCore() composition root
│   ├── config/           user/*.json paths, readers and provider/model resolution
│   ├── model/            provider requests, usage, model catalog
│   ├── context/          prompt, input refs, compaction, token anchors, cwd
│   ├── interactions/     approvals, questions, plan reviews, user jobs
│   ├── rpc/              command registry + params schema
│   ├── agent.js          turn runtime: chat / loop dispatch / turn state
│   ├── loops/            node-graph (active) + linear (frozen)
│   ├── tools/            tool registry / executor / result shaping
│   ├── storage/          session / data persistence
│   ├── skills/           skill registry and filesystem provider
│   ├── network/          provider HTTP client and tracker
│   ├── transport.js      transport registry
│   ├── transports/       http / ipc
│   ├── workflow/         workflow runs: subagent port, lifecycle, domain events
│   ├── flow/             user-edited node graphs: validation, executor, node types
│   └── subagent-runtime.js
├── lib/                  host-agnostic facilities (shared by core and tools)
│   └── workflow-runtime/ workflow script mechanism: hooks, caps, value materialization
├── tools/                pluggable tools
├── ui/
│   ├── electron/         electron client (main.js / preload.js)
│   └── web/              renderer modules
└── docs/                 documentation tree (docs/README.md)
```

### Tools

Each subdirectory under `tools/` is a standalone tool.
A tool declares its own interface by `registry.json`.


### Configuration

now config files in `user/` includes:
basic `settings.json`, `providers.json`;
permit `permissions.json`, `bash-policy.json`, `fs-policy.json`;
external MCP servers `mcp.json`

`user/` is not tracked by git. To connect an external service such as the
Reference Memory server, see [docs/usage/mcp-memory.md](docs/usage/mcp-memory.md).


## Documentation

The documentation tree starts at [`docs/README.md`](docs/README.md). The root README introduces the project; the docs README introduces the tree.

## Module design

Two commitments define the module layer's design:

- **Module = runtime capability package.** Modules are decoupled at compile time and joined at runtime through a registry. 
- **Observability is a baseline module-design rule, not a standalone feature.** 
Every module emits observable signals by default — spans / trajectory / cost / latency metrics. 
This is a fundamental design guideline for modules rather than an optional add-on.


## License

GNU General Public License v3.0 — see `LICENSE`.
