# lib

Host-agnostic shared facilities used by both `core/` and `tools/`.

Rules (enforced by `scripts/graph/arch-rules.json`, rule `lib-is-a-leaf`):

- `lib/` depends only on Node built-ins and third-party packages.
- `lib/` must never import `core/`, `tools/`, `ui/`, `providers/` or `scripts/`.
- If a facility needs core state, pass it in as an argument; do not import it.

Each subdirectory exposes its API through `index.js`. A module belongs here only
when it is host-independent and used by more than one layer, or when it is an
outward contract (such as the tool result shape). See `arch.md` section 1.3.

| Directory | Purpose |
|---|---|
| `paths/` | Project root resolution for absolute-path facilities |
| `tool-result/` | Model-facing tool result shaping, truncation, spill |
| `fs-observe/` | Read-before-write observation and version CAS |
| `shell-env/` | Managed `DSH_*` shell environment |
| `skill-content/` | Skill content rendering and escaping |
| `skill-policy/` | Skill name validation and invocation policy |
| `skill-instance/` | Active skills registry accessor |
| `todo-state/` | Per-session todo projection primitives |
