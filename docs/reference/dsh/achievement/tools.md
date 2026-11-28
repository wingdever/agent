# 工具（实现层）

对应原型：`../prototype/tools/`（工具总览、77 份工具页、执行器模式、有状态组合包）。

## 当前实现

### 注册方式

- 工具目录：项目根 `tools/<name>/`，每目录一份 `registry.json` 与一个入口模块。
- 扫描：`core/tools/registry.js` 的 `loadTools()` 读 `tools/*/registry.json`，加载 `entry`（默认 `run.js`），规整模型可见字段与运行时选项。
- 这是**我们独有的设计**：原型的工具由各插件在运行时用 `defineTool()` 向 `ctx.tools` 注册，不存在"扫描目录里的 JSON"这一层。

### 同名槽位（provider 互斥）

- `registry.json` 的 `name` 是模型可见槽位；目录只是包，不是身份。
- 多个包可以声明同一个 `name`，`loadTools()` 只选一个注册，模型永远看不到两个同名工具。
- 选择顺序：`AGENT_TOOL_PROVIDER_<NAME>` → `defaultProvider` → 最高 `priority`。
- `bash` 已按此实现两个 provider：`tools/bash`（`foreground`，一次性 `bash -c`）与 `tools/bash-persistent`（`persistent`，长驻 shell）。默认 `persistent`，设置 `AGENT_TOOL_PROVIDER_BASH=foreground` 切换。
- 持久 provider 的会话状态由 `lib/terminals/` 承载，`core` 通过 `exec.terminals` 注入；与原型 `ctx.terminals` 对应。默认走 PTY（`node-pty`），`AGENT_BASH_TERMINAL_BACKEND=pipe` 可回退到无原生依赖的 pipe 实现。
- 终端六件套也已落在同一服务上：`terminal_open` 创建一个独立的交互 PTY（不是持久 bash 的 FIFO 命令队列），`terminal_send` 直接写该 PTY 的 stdin，`terminal_read` 读保留输出环，`terminal_signal` 按 `/proc` 的前台进程组发信号，`terminal_close` 清理并等待捕获的进程树。六个工具共用 `tool:pty`（1700）提示段落，owner 隔离按 `exec.sessionId` 分区。
- `lsp` 已按原型落成一个工具 + `operation` 四操作：`goToDefinition` / `findReferences` / `goToImplementation` / `hover`。`core/lsp` 按 `user/lsp.json` 的 stdio provider 懒启动语言服务器，按 `exec.cwd` 打开文档，首次查询做 `didOpen`，内容变化做全文 `didChange`；没有 provider 时 schema 不变、执行返回 `LSP_UNAVAILABLE`。
- `present` 已按原型的 `files` 契约落地：`tools/present` 只声明现有普通文件（每个 `{ path, description? }`，最多 4 个），不复制内容；`meta.files` 供宿主渲染文件卡片，`call.result` 随会话持久化。
- `user_terminal_list` / `user_terminal_read` 已在终端面板上落地：`createdBy=user` 或用户接管的终端由只读工具读取；xterm headless 维护屏幕，WebSocket 双向传原始字节。与 `pty` 六件套共用 `lib/terminals`，但使用独立 `tool:pty-panel`（1710）提示段落。

### registry.json 字段

| 字段 | 作用 |
|---|---|
| `name` / `description` / `parameters` | 模型可见的声明三要素 |
| `prompt` | 贡献到系统提示词的该工具指引段落 |
| `promptSection` | 多个工具共用同一段指引时的段名 |
| `type` | 工具分类（`fs` / `bash` / `interaction` / `goal` / …） |
| `entry` | 入口文件名，默认 `run.js` |
| `timeoutMs` / `concurrencySafe` | 运行时选项，不发往模型 |
| `defaultVisible` | 默认是否下发给模型 |
| `provider` / `priority` / `defaultProvider` | 同名槽位的 provider 选择；保证同名工具只注册一个 |

### 可见性与选择

- `core/tools/index.js` 的 `select(toolNames)`：显式传 `toolNames` 时按其顺序；否则取 `defaultVisible !== false` 的全部工具，按名字字典序排序。
- 当前 62 个工具包、61 个模型可见槽位中，58 个默认下发，3 个默认隐藏（`calculator`、`get_current_time`、`run_code`）。`bash` 的一次性与持久 provider 共用一个槽位。

### 声明形态

`defs(tools)` 把每个工具投影成 Chat Completions 的函数声明：

```json
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": { } } }
```

`output`、超时、并发标记、提示段落、展示回调都不进声明。

### 执行与结果

- 参数校验：`core/tools/schema.js` 的 `validateSchema()`，在审批之前返回 `invalid arguments` 类错误。
- 执行：`core/tools/executor.js` 的 `runTool(tool, args, exec)` 调用 `tool.run()`。
- 结果整形：`lib/tool-result` 的 `normalizeResult()` —— 字符串原样、`{ text, meta }` 取 `text`、`meta` 只进 UI/DB；错误统一 `Error: <message>`。
- 超长结果截尾并写 spill 文件到 `tmp/tool-output/<callId>/<name>.txt`。

## 与原型的关系

### 已对齐

- **声明三要素**：只有 `name` / `description` / `parameters` 进入模型请求。
- **结果面**：模型只看到文本；`meta` 只进 UI/DB，不进模型消息。
- **错误文本**：统一 `Error: <message>`，与原型同一前缀。
- **参数错误先于审批**：校验失败不弹审批。
- **工具指引排序**：`toolOrders` 表沿用原型 DSH 的固定序号（bash 1000 / read 1100 / … / pty 1700 / pty-panel 1710 / goal 2400）。
- **共用段落的 `{{tools}}` 替换**：多个工具共用一个 `promptSection` 时，用可见工具名以 ` or ` 连接。
- **`bash` 同名槽位**：一次性与持久 provider 互斥，模型可见名都是 `bash`；持久 provider 的 `cd` / `export` 状态跨调用保留，超时/取消后重建。持久 provider 默认使用 PTY 后端，pipe 后端保留为可选回退。

### 实现差异（已决定）

- **目录扫描注册 vs 运行时插件注册**：我们用 `tools/*/registry.json` 静态扫描，原型用 `defineTool()` 动态注册。这是本项目在"模块 = 运行时能力包"路线下选择的加载方式。
- **协议不同**：声明是 Chat Completions 的 `type: "function"` 形态，原型是 Messages 的 `name` / `description` / `input_schema`。
- **工具目录（tool list）用数组**，原型用 `toolOrder` 配置加 `<unlisted-tools>` 占位项的规范化排序。

### 待对齐

- **工具结果按 `output.schema` 校验**：原型每个工具声明输出 schema 并强制校验，我们只有文本输出，没有输出 schema。
- **展示投影**：`present` 已有专用 `meta.files` + UI 文件卡片；仍没有原型那样通用、可重放的 `presentResult` / `presentationMeta` 回调。
- **`deferLoading`**：原型支持工具延迟加载与 `tool_addition`，我们没有（Chat Completions 下也没有对应语义）。
- **工具激活谓词 `when`**：原型可按步决定工具是否披露，我们只有静态 `defaultVisible`。

### 未实现

- **执行器模式（基础版）**：已实现 native / `ptc` 两种模式；`AGENT_TOOL_EXECUTOR=ptc` 时 `run_code` 是唯一直接可见工具，其他工具经生成的 `tools:sdk` 暴露。与原型仍有差距：没有 OS 级沙箱、输出 schema 校验和展示投影。
- **有状态组合包**：原型的 14 个组合包里，我们实现了两类形态：共用段落（goal 三件套、user job 三件套、subagent 组），以及 `bash` 的同名 provider 互斥（一次性 / 持久）。其余依赖兄弟工具可见性而改变段落文本的（`write`/`edit`、`grep`/`read`、`web_search`/`web_fetch`）都没实现。
- **工具限制 `tools.restrict()`**：原型可以用它隐藏工具，我们没有。
- **MCP 进阶能力**：资源订阅（`resources/subscribe`）、prompt 模板、采样 / elicitation / roots 与 tasks extension 都没有。
- 原型 77 个工具中，`present` 已补齐；剩余差额以原型文档为准，逐条见 `prototype/tools/README.md` 的索引。

### 明确不做

- **权限门之外的沙箱字段**：`sandbox_permissions` / `justification` 在原型里是工具 schema 的可选字段，按其行为语义我们只保留接口描述、不解析不生效（依据 AGENTS.md 第 7 条）。
- **`defer_loading` 与工具增删消息**：Chat Completions 协议没有对应表达。

### 我们独有

- **`registry.json` 声明式注册**：原型没有这种形态。
- **`type` 分类与 `promptSection` 的 `{{tools}}` 文本替换**：原型的共用段落由各插件自行实现，没有统一的占位符约定。
- **`tmp/tool-output/` 下的 spill 落盘**：原型用 `ctx.spillStore` 抽象，我们直接写项目临时目录。

## 后续计划

1. 为工具补输出 schema 与结果校验（对应原型 `output.schema`）。
2. 按需引入工具激活谓词，替代只有 `defaultVisible` 的静态可见性。
3. 逐个对齐原型工具的 description 与 schema，优先 `read` / `write` / `edit` / `bash` / `glob` / `grep`。
