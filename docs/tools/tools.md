## 工具实现方案

> 状态（2026-11-03）：P0 已实现 `read` / `write` / `edit` / `glob` / `grep` / `bash`；
> P1 已实现 `ask_user_question`（UI 挂起问答）；P2 已实现 `todo_write` 和
> `create_goal` / `get_goal` / `update_goal`（goal 自动续轮待做）；
> P3 已实现 `web_search`（Tavily）/ `web_fetch`（HTTP + HTML→Markdown）；
> P5 已提前实现 plan 模式 + `exit_plan_mode`。
> `write` / `edit` 的观察约束、`bash` 的超时/截断、`glob`/`grep` 的 spill 均已落地。
> 工具优先级、模型接口约定和后续阶段见 `docs/tool-plan.md`。

### 目录约定
- 工具代码：项目根 `tools/`
- 工具文档：本文件 `docs/tool.md`

### 工具注册机制
目录化注册（扫描 tools/*/registry.json）

registry.json 字段：
- `name` / `description` / `parameters` / `entry`：工具身份与实现入口（`entry` 默认 `run.js`）
- `mode`：读写特性，`read`（只读）/ `write`（可写）/ `both`（视情况可写）；权限预设按它判定
- `group`：能力分组，`fs` / `shell` / `terminal` / `code` / `web` / `browser` / `job` / `agent` / `team` / `schedule` / `goal` / `interaction` / `deliverable` / `channel` / `skill` / `mcp` / `utility`；工具页按它分类。只有 `mcp__<server>__<tool>` 形式的工具归入 MCP 子标签并按服务器名分组，`skill` 与共享注册的 MCP 资源工具（`group: mcp`）留在内置工具里
- `prompt`（可选）：该工具贡献到 system prompt 的指引段落；order 由工具名查固定表
- `promptSection`（可选）：多个工具共享同一段指引时使用（goal 三件套用 `goal`）
- `timeoutMs`（可选）：执行器预算；`concurrencySafe`（可选）：并发标记（与 `mode` 无关，是调度层的并行开关）
- `defaultVisible`（可选，默认 true）：false 时默认不下发给模型（如 `calculator`）
- `provider`（可选）：同名槽位的 provider 标识，缺省取目录名；`priority`（可选）：没有显式选择时按它选最高者；`defaultProvider`（可选）：显式标记默认 provider
- `result`（可选，默认 `text`）：`text` / `json`

**同名槽位与 provider 互斥**：`name` 是工具槽位，不是目录名。多个包可以声明同一个 `name`，但 `loadTools()` 只注册其中一个，绝不出现两个同名工具。选择顺序是：`AGENT_TOOL_PROVIDER_<NAME>`（如 `AGENT_TOOL_PROVIDER_BASH`）→ `defaultProvider` → 最高 `priority`。当前 `bash` 槽位有两个 provider：一次性 `tools/bash`（`foreground`）和持久 `tools/bash-persistent`（`persistent`，默认）。

工具权限不在 registry 里声明，统一由 `user/permissions.json` 决定（见「工具权限」）。

工具实现导出 `async run(args, exec)`；`exec.cwd` 是本轮会话所属 workspace 的绝对路径，
`exec.sessionId` 用于 fs observation 等会话态。返回值是模型可见文本（string），或
`{ text, meta, content? }`；`meta` 只进 UI/DB，不进模型消息。`content` 是多模态工具的
provider-ready content parts（例如 `image_url`），只有存在时才把 tool 消息的 `content`
从字符串升级为数组；文本信封仍在数组第一项。工具抛错统一渲染为 `Error: ...`。

### 工具状态
- 已实现（P0）：`read`、`write`、`edit`、`glob`、`grep`、`bash`
- 已实现（P0，bash 槽位）：`bash-persistent`（模型可见名仍为 `bash`；与一次性 `bash` 互斥）
- 已实现（P0，终端）：`terminal_open`、`terminal_list`、`terminal_read`、`terminal_send`、`terminal_signal`、`terminal_close`
- 已实现（P0，终端面板）：`user_terminal_list`、`user_terminal_read`；侧栏 xterm + WebSocket 通道
- 已实现（P2，代码导航）：`lsp`（一个工具 + 四个 operation）
- 已实现（P2，交付）：`present`（`files` 数组，最多 4 个文件；只声明现有文件，不复制内容）
- 已实现（P0，FS 三件套）：`apply_patch`、`str_replace_editor`、`read_image`
- 已实现（委托）：`wait_agent`
- 已实现（执行器）：`run_code`
- 已实现（P1）：`ask_user_question`
- 已实现（P2）：`todo_write`、`create_goal`、`get_goal`、`update_goal`
- 已实现（P3）：`web_search`、`web_fetch`
- 已实现（P5，提前）：plan 模式 + `exit_plan_mode`
- 默认隐藏：`calculator`、`get_current_time`（`defaultVisible: false`）
- 仍未实现：`session_search` 等会话检索、Office 三件套、`plugin_manager` 等；
  见 `docs/path/dsh/achievement/capability-gap.md` 的缺口表

### 工具执行
tools/pre-execute

#### 取消
一轮对话被停止时，`exec.signal` 是中断信号：工具若会等待外部资源，应把它交给底层调用，使等待立即结束。工具体一旦启动就不会被抛弃，而是先跑到静止，再由执行器改写结果，因此半途的副作用不会被当作没发生。

取消后的模型可见结果按工具体是否启动区分：

| 情形 | 结果文本 | isError |
| --- | --- | --- |
| 工具体尚未启动 | `Error: tool call aborted before dispatch` | true |
| 工具体已启动（无论正常返回还是抛错） | `Error: tool call aborted` | true |

与取消无关的失败保留自身错误文本。取消发生在工具执行完之后时，该轮不再请求模型、不再发起新的工具调用，以 `stopReason: "interrupted"` 正常结束，不计为失败。

### bash（一次性 / 持久同名 provider）
- 注册：`tools/bash/registry.json`（`provider: foreground`）与 `tools/bash-persistent/registry.json`（`provider: persistent`）；模型可见名都是 `bash`
- 选择：默认 `persistent`；`AGENT_TOOL_PROVIDER_BASH=foreground` 切回一次性 `bash`
- 一次性：每次 `bash -c` 新 shell，cwd / 环境变量不跨调用保留；参数 `description` / `command` / `timeoutMs` / `workdir`
- 持久：每会话一个长驻 shell，参数只有 `command`；`cd`、`export`、函数和 shell 选项跨调用保留
- 持久实现：`lib/terminals/`；默认 `pty` 后端（`node-pty`），命令以 base64 走私有 FIFO，stdout 走终端、stderr 写临时文件，完成标记走 fd3；`pipe` 后端保留，命令走私有 fd，stdout / stderr 各自独立
- 后端选择：`AGENT_BASH_TERMINAL_BACKEND=pty`（默认）/ `pipe`；PTY 不可用时自动回退 pipe
- 持久结果：stdout、`[stderr]` 段、`[exit code: N]` 标记；每次流仍截尾 64KB 并写 spill
- 生命周期：超时（120s）或取消会销毁当前 shell，下一次调用重建；硬删除会话时关闭对应 shell；空闲 30 分钟回收
- 差异：PTY 下 shell 的 stdin/stdout 是终端，`isatty` 为真；但 `bash` 调用本身是同步的，需要持续键盘输入的交互式程序仍不适合直接作为一次调用运行
- 审批：两个 provider 共用 `tools/lib/bash-gate.js`，参数校验和文件策略门控与一次性 bash 一致

### present（交付文件）
- 注册：`tools/present/registry.json`；实现：`tools/present/run.js`
- 参数：`files`（必填，1–4 项）；每项 `{ path, description? }`，`path` 必须是现有普通文件，相对路径按 `exec.cwd` 解析；不复制、不移动、不读取文件内容
- 返回：`Presented N file(s) to the user:` + 相对路径/描述列表，并说明文件保留在原路径；`meta.files` 带 `path` / `display` / `name` / `description` / `bytes` / `mtimeMs`
- UI：工具卡内渲染“已交付 N 个文件”列表，每项可打开右栏 `artifact-preview`；历史回放优先读 `call.result.meta.files`，旧记录回落到 `arguments.files`
- 持久化：不新增表；交付记录随 `calls.result` 的 `meta` 落库，宿主在自己的回合结束后展示
- 可见性：`group=deliverable`、`mode=read`、默认可见；没有单独的系统提示段落，行为说明只放在 tool description
- 审批：仍走统一的 `user/permissions.json`；默认 `ask` 时会先弹批准卡，若希望交付不打断，可在本机把 `present` 配成 `allow`
- 测试：`test/tools/present/present.test.js`，覆盖注册、相对/绝对路径、描述、大小、空数组、超过 4 个、缺失文件和目录

### terminal（持久交互终端六件套）
- 注册：`tools/terminal_open`、`terminal_list`、`terminal_read`、`terminal_send`、`terminal_signal`、`terminal_close`；共用系统提示段落 `tool:pty`（order 1700）
- 实现：`lib/terminals/` 的 `InteractiveTerminal` 与 `TerminalService.open/list/read/send/signal/closeTerminal`；每个终端一条独立 PTY 里的交互 bash，不复用 `bash` 工具的 FIFO 命令队列，因此 `terminal_send` 写入的是 shell 的真实 stdin
- owner 隔离：`TerminalService` 按 `exec.sessionId`（无会话时回退 `agent:<key>`）分区；`terminal_list` 只列本 owner 的终端，跨 owner 的 read/send/signal/close 都报 `no persistent terminal found`
- `terminal_open`：参数 `type`（`shell` / `bash`，底层都是 bash）、可选 `name`、可选 `cwd`（相对 `exec.cwd` 解析）；返回 id、名称、类型、初始目录
- `terminal_read`：从保留输出环读取，最多保留 200 KiB；`count` 默认 500、上限 2000；`offset` 按最新行回退，0 表示最新一页
- `terminal_send`：默认追加 Enter 并等待 prompt、输出静默、无输出、超时或会话退出；`submit:false` 只写入不提交，用于控制字符和不完整 REPL 输入；`run_in_background:true` 走 `JobService`，返回 `job_...`，可用 `job_output` / `job_kill`
- `terminal_signal`：读取 `/proc/<shell>/stat` 的 `tpgid`，向该前台进程组发送 `SIGINT` / `SIGTERM` / `SIGKILL` / `SIGTSTP` / `SIGHUP`；前台进程组就是 shell 自身时拒绝 `SIGKILL`，要求改用 `terminal_close`
- `terminal_close`：用户接管前先快照 shell 的后代进程，按 SIGHUP → SIGTERM → SIGKILL 递进清理，并等待快照中的进程消失；用户接管后只 detach，不杀进程，终端继续留在侧栏由用户控制
- 限制：`terminal_send` 的“静默/无输出”只表示本次观察窗口内没有更多输出，不证明前台命令已经退出；长时间运行的命令应配合 `run_in_background` 或后续 `terminal_read`

### user_terminal（侧栏终端只读投影）
- 注册：`tools/user_terminal_list`、`tools/user_terminal_read`；共用系统提示段落 `tool:pty-panel`（order 1710），`promptSection=pty-panel`
- 语义：这两个工具只读；模型不能向用户终端输入。用户侧栏终端、以及用户从 agent 终端接管来的终端，都归 `user_terminal_*` 读取；agent 自己的 `terminal_*` 继续按 owner 隔离。
- `user_terminal_list`：无参数；返回 id、名称、启动目录、`running=yes|no|unknown`（`/proc` 前台进程组：shell 自己为 no，子进程组为 yes，读取失败为 unknown）；只列 `control=user` 的侧栏终端。
- `user_terminal_read`：`{ id, lines? }`，默认 500、上限 2000；读取 `@xterm/headless` 的 active buffer 渲染后的纯文本，不读原始 ANSI 输出；`lines` 必须为正整数。
- 所有权：用户首次向某条终端写入原始键盘字节时，服务端原子地把 `control` 从 `agent` 切到 `user`，不可逆；此后 `terminal_send` / `terminal_signal` 返回 `controlled by the user` 错误，`terminal_close` 只 detach，并从 agent 的 `terminal_list` 中移除。
- 可见性：侧栏挂载时两个工具默认可见；`AGENT_TERMINAL_PANEL=0` 或 `AGENT_TRANSPORT=ipc` 时两个工具从默认下发集合移除，`tool:pty-panel` 段落随可见工具一起消失。
- 面板传输：`POST /api/call` 的 RPC `terminal.panel.list/open/close` 管理终端；每个终端一条 `ws://127.0.0.1:<port>/terminal?sessionId=…&terminalId=…&cols=…&rows=…`。服务端先发 JSON `hello`（`snapshot` 为 `@xterm/addon-serialize` 的屏幕快照），之后二进制帧双向传 PTY 原始输出/键盘输入；文本帧承载 `resize` / `ping`。断线重连时重新发快照，不丢屏幕状态。
- 第一版边界：只支持 HTTP transport；不做跨进程持久化、SSH、Windows shell、应用重启后的终端恢复；Host 退出即销毁终端。完整设计与协议见 `docs/tools/terminal-panel.md`。

### lsp（语言服务器代码导航）
- 注册：`tools/lsp/registry.json`；实现：`tools/lsp/run.js`、`tools/lsp/format.js`；`group: code`；共用系统提示段落 `tool:lsp`（order 2200）
- 工具形态：只有一个 `lsp` 工具，`operation` 枚举 `goToDefinition` / `findReferences` / `goToImplementation` / `hover`；参数固定为 `operation`、`file_path`、`line`、`character`
- 坐标：`line` / `character` 都是 1-based，`character` 按 UTF-16 code unit 计数；服务层转换为 LSP 的 0-based Position，返回结果再转回 1-based
- provider：`user/lsp.json` 的 `servers` 表；每个条目包含 `command` / `args` / `extensions` 或 `languageIds` / `root` / `env` / `initializationOptions` / `settings` / `timeoutMs` / `idleTimeoutMs`。按扩展名选择 provider，默认 root 是 `exec.cwd`
- 示例：
  ```json
  {
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "languageIds": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact"
        }
      }
    }
  }
  ```
- 生命周期：懒启动；按 `provider + workspaceRoot` 共享语言服务器；`initialize` / `initialized` 后对文件发 `didOpen`，内容变化时发全文 `didChange`；请求串行化、支持取消、空闲 10 分钟 `shutdown` / `exit`，崩溃后下一次查询重启
- 可见性：没有匹配 provider 时工具仍然可见，执行返回 `Error: LSP_UNAVAILABLE: ...`；已配置但启动失败返回 `LSP_START_FAILED`
- 结果：定义/实现/引用返回 `相对路径:1-based行:1-based列` 列表，引用请求固定带 `includeDeclaration: true`；hover 输出 Markdown/纯文本；位置列表最多 50 条，hover 最多 16 KB
- 能力缺口：首版只接受 UTF-16 位置编码；服务器强制 `utf-8` / `utf-32` 时返回 `LSP_UNSUPPORTED_POSITION_ENCODING`
- 测试：`test/tools/lsp/lsp.test.js` + `test/fixtures/lsp-server.js`，覆盖 JSON-RPC framing、文档同步、四种操作、坐标转换、超时、无 provider 和结果截断

### read（读文本文件）
- 注册：`tools/read/registry.json`；实现：`tools/read/run.js`
- 参数：`file_path`（必填）、`offset`（1 起，默认 1）、`limit`（默认/最大 2000 行）
- 返回：纯文本信封，而非 JSON：
  ```
  <path>/abs/path</path>
  <type>file</type>
  <content>
  1: first line
  2: second line

  (End of file - total 2 lines)
  </content>
  ```
- 上限：单行截断 2000 字符、单次最多 50KB；达到上限时 footer 提示用 `offset` 续读
- 大文件：`stat.size >= 10MB` 走流式扫描，不整文件读入内存
- 报错：不存在、非普通文件、无权限、offset 超出 EOF、UTF-8 首块含 NUL 判为二进制
- 审批：由 `user/permissions.json` 的 `read` 档位决定（当前为 `allow`，不弹授权）；绝对路径照读，不做 workspace 包含性限制

### apply_patch（跨文件补丁）
- 注册：`tools/apply_patch/registry.json`；实现：`tools/apply_patch/run.js`
- 参数：`input`（必填，`*** Begin Patch` … `*** End Patch`）
- 支持 `*** Add File:`、`*** Update File:`（可跟 `*** Move to:`）、`*** Delete File:`；hunk 以 `@@` 或 `@@ anchor` 开头，行前缀为空格/`+`/`-`，`*** End of File` 锚定文件末尾
- 契约：先解析并对照当前文件校验全部 hunk 与路径；整包校验通过后才开始落盘。落盘按顺序执行，首个失败即停止，不回滚
- 匹配：hunk 的旧行序列必须在文件中恰好命中一次；无 context 的纯插入必须给 `@@ anchor`，且 anchor 只能命中一行
- 返回：`Success. Updated the following files:` + `A/M/D` 路径列表；`meta.files` 带每个文件的 `operation`、`before`、`after`（超 200KB 不放入 meta）
- 审批：`group=fs`、`mode=write`，走 `user/fs-policy.json` 的多路径检查；任一目标命中 deny 即拒绝

### str_replace_editor（查看/创建/替换/插入）
- 注册：`tools/str_replace_editor/registry.json`；实现：`tools/str_replace_editor/run.js`
- 参数：`command`（`view` / `create` / `str_replace` / `insert`）、`path`；其余参数只在对应命令使用，DSH schema 的 `null` 占位按省略处理
- `view`：文件按 `cat -n` 行号输出，支持 `view_range: [start, end]`（`end=-1` 到 EOF）；目录列出非隐藏文件/目录，最多 2 层；单次最多 2000 行/50KB
- `create`：目标不存在时创建，自动建父目录；已存在则拒绝
- `str_replace`：`old_str` 必须文件内唯一命中；`new_str` 省略或 `null` 表示删除匹配
- `insert`：在 `insert_line` 行之后插入（0 表示文件开头）
- 与 `read`/`write`/`edit` 不同，本工具不走 read-before-write 的 fs observation；写权限仍由 `fs-policy` 检查
- 返回：创建/编辑成功文本；`meta.files` 带 `before`/`after` 供 UI diff

### read_image（读取图片）
- 注册：`tools/read_image/registry.json`；实现：`tools/read_image/run.js` + `lib/attachments/`
- 参数：`file_path`（必填）
- 格式：按 magic bytes 识别 PNG/JPEG/WebP/GIF，不信任扩展名；解析宽高，写入 content-addressed 的 `data/attachments/<sha256>.<ext>`（只读）
- 模型通道：返回文本信封（path/media_type/dimensions/bytes/attachment_id/attachment_path）+ `content: [{ type: "image_url", image_url: { url: "data:..." } }]`；provider 必须支持 tool 消息中的 `image_url` content part，纯文本 provider 不应开启本工具
- 上限：8MB；超过直接报错，不做隐式缩放
- 审批：`mode=read`，不写文件；附件落盘属于工具内部持久化
- 后续会话：文本信封保留 attachment 引用；需要重新看图时再次调用 `read_image`，不依赖历史消息里的 base64

### wait_agent（等待下一步输入）
- 注册：`tools/wait_agent/registry.json`；实现：`tools/wait_agent/run.js`
- 参数：`timeout_ms`（integer，10000–3600000，默认 30000）
- 语义：等待调用方自己的 `nextStep` 出现此前未报告过的输入；等待不消费，真正的领取在下一个 step 边界
- 返回：`{ timedOut }`；有新输入立即返回 `false`，超时返回 `true`。同一 step 内已经报告过的消息不会再次唤醒
- 接线：node-graph 的 `tool-execute.delegation.waitAgent` 注入 `callerSessionId` 与 `ctx.signal`；取消时以错误结束，不悬挂
- 相关：运行中目标的 `send_message`、运行中父会话的 `subagent-settle` 都进 `nextStep`；`pre-step` 领取后由 `model-call` 以原 `source` 落库

### run_code（PTC 执行器入口）
- 注册：`tools/run_code/registry.json`；实现：`tools/run_code/run.js` + `lib/code-runner/`
- 参数：`code`（async 函数体，必填）、`description`（必填）、`timeoutMs`（默认 120000，上限 600000）
- 执行：每次 `fork` 一个全新 Node 进程；`stripTypeScriptTypes` 只做擦除式类型剥离；支持顶层 `await` / `return`；`process.env` 为空；cwd 取本轮会话目录
- 子调用：程序内 `await tools.<name>(args)` 通过 IPC 回到 `tool-execute`，复用参数校验、权限、审批、取消和错误文本；`run_code` 不能嵌套调用自己
- 输出：`inspect(...values)` 按调用顺序产生文本与 `image_url` 内容块；子调用结果只进程序，不单独进入模型消息
- 超时/取消：总预算包含嵌套工具与审批等待；超时或 `ctx.signal` abort 会终止子进程并中止嵌套调用
- 可见性：native 模式下默认隐藏；设置 `AGENT_TOOL_EXECUTOR=ptc` 时 `run_code` 是唯一直接可见工具，其他默认可见工具通过生成的 `tools:sdk` TypeScript 声明暴露
- 边界：当前没有 OS 级沙箱，程序内 `await import("node:fs")` 等直接 Node API 不受 `fs-policy` 约束；需要严格文件策略时应只通过 `tools.*` 调用

### web_search（联网搜索）
- 注册：`tools/web_search/registry.json`；实现：`tools/web_search/run.js` + `tools/lib/web/`
- 参数：`queries`（必填，1–4 条，合并去重）
- provider：Tavily `POST /search`；结果映射为 `{ answer?, sources[], truncated }`
- 多 query：并发执行、按 rank 轮转合并、按 URL 去重，最多 8 个源；answer 以 `### <query>` 分段
- 结果文本（与 DSH 一致）：外部内容声明 → answer → `Sources:` markdown 列表（含 snippet 与日期）→ 截断提示 → 引用提示；无结果时为 `No results found.`
- 配置：`user/settings.json` 的 `web.tavilyApiKey`（`TAVILY_API_KEY` 兜底）；可选 `web.tavily.{baseUrl,searchDepth,includeAnswer}`
- 上限：30s 超时；结果数 8、query 数 4 固定在代码里，与 registry 描述保持一致
- 审批：`web_search` 当前为 `allow`（只读外部请求）；缺 key 时返回 `Error: web_search is unavailable: missing Tavily API key ...`

### web_fetch（抓取网页）
- 注册：`tools/web_fetch/registry.json`；实现：`tools/web_fetch/run.js` + `tools/lib/web/`
- 参数：`url`（必填，HTTP(S)）
- 抓取策略（对齐 DSH `web-fetch-http`）：
  - URL ≤ 2048 字符、仅 http/https、禁止内嵌凭据
  - DNS 解析后校验整个地址集，拒绝回环/内网/非公网 IP，并把地址 pin 到连接
  - 仅跟随同源重定向（最多 5 跳）；跨域重定向报错，要求直接重试目标 URL
  - 响应体最多 5MB、解码后 10 万字符；超限时截断并标记
  - `Content-Type`：`text/html`/XHTML → turndown（GFM 表格）转 Markdown；其他 `text/*`、JSON/XML 原样返回；其他类型报 `unsupported content type`
  - 输出整体上限 20 万字符；截断时追加 `(Content truncated. Fetch a more specific URL or section for the full text.)`
- 结果文本：`Fetched <url> (HTTP <code>)` + 外部内容声明 + 正文；4xx/5xx 仍返回正文与状态码
- 依赖：`turndown` + `@joplin/turndown-plugin-gfm`（HTML→Markdown）、`ipaddr.js`（公网地址判定）
- 审批：`web_fetch` 当前为 `allow`（只读外部请求）

### 具体约定
参照deepseek-harness具体的工具与模型通信的约定

### 权限请求
approval-request { id, callId, name, arguments, permission }

- `permission: "ask"`：等待用户点击批准/拒绝（`id` 回传给 `approval`）
- `permission: "allow"`：无需等待，直接执行
- `permission: "deny"`：不执行，工具结果写 `{ "error": "permission denied" }`，`call.status = "denied"`
- `callId` 始终指向对应的 tool call，用于把审批卡片挂到正确的 `tool-call-card`

### 工具权限（user/permissions.json）
每轮对话开始时读取一次；本机配置，`user/` 不入 git。格式：

```json
{
  "default": "ask",
  "tools": [
    { "name": "read", "permission": "allow" },
    { "name": "bash", "permission": "ask" }
  ]
}
```

- 档位：`allow` / `ask` / `deny`；未列出的工具取 `default`，`default` 缺省 `ask`
- 文件缺失、JSON 损坏、`default` 或某工具档位非法：该处按 `ask` 处理并 `console.error`（fail closed）
- 未注册的工具名允许先写（例如预留的 `write`），运行时只查当前可见工具

### 文件写精细控制（user/fs-policy.json）
对 `write` / `edit` 两类文件写工具，在工具级档位之上叠加**按路径**的精细控制：可按目录、按文件、按 glob 自动 `allow`（跳过审批）或 `deny`（直接拒绝）。与 `permissions.json` 并列，本机配置，`user/` 不入 git。格式：

```json
{
  "rules": [
    { "path": "docs/**", "permission": "deny" },
    { "path": "src/**/*.test.js", "permission": "allow" },
    { "path": "/abs/secrets/**", "permission": "deny" }
  ]
}
```

- 作用域：仅 `write` / `edit`。其他工具完全由 `permissions.json` 决定。
- 匹配基准：每条 `path` 既按**绝对路径**匹配，也按**相对 workspace 根**匹配（`docs/**` 可匹配任意位置下的 `docs/` 子目录，无需写全绝对前缀）。`**` 跨任意层级，`*` 单段，`?` 单字符。
- 决策顺序：**先扫 deny，任一 deny 命中即拒绝**（否决更早的 allow）；否则首条命中的 allow/ask 生效；均未命中则回退到 `permissions.json` 的工具级档位。
- 失败行为：文件缺失、JSON 损坏、某条规则缺 `path` 或档位非法——坏规则被丢弃（含整体损坏时忽略全部规则），完全回退到 `permissions.json`，绝不悄悄放宽或收紧（fail open 到原门控）。

### 模型通信
#### 发送工具清单
payload["tools"] = [
  {
      "type": "function",
      "function": {
          "name": tool.name,
          "description": tool.description,
          "parameters": tool.parameters,
      },
  }
  for tool in tools
]

#### 处理工具调用
for raw_call in raw_message.get("tool_calls") or []:
    tool_calls.append(
        ToolCall(
            id=raw_call["id"],
            name=raw_call["function"]["name"],
            arguments=raw_call["function"]["arguments"],
        )
    )
return Message(
    role="assistant",
    content=raw_message.get("content"),
    reasoning_content=raw_message.get("reasoning_content"),
    tool_calls=tuple(tool_calls),
)

## deepseek-harness参考

所有通过 defineTool 注册的工具，共 55 个，分布在 23 个 tool-*包中。

> 这是 DSH 的原型参考清单，不代表本项目全部实现。本项目 shell 面仅支持 Linux：`bash` 一次性 / 持久 provider + PTY 终端；`pwsh` / 持久 `pwsh` 明确不做。


  文件 / Shell 类

  ┌────────────────────┬──────────────────────────────────────────────────┐
  │        工具        │                     实现文件                     │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ read               │ packages/fs/tool-fs/src/read.ts                  │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ read_image         │ packages/fs/tool-fs/src/read-image.ts            │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ write              │ packages/fs/tool-fs/src/write.ts                 │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ edit               │ packages/fs/tool-fs/src/edit.ts                  │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ str_replace_editor │ packages/fs/tool-str-replace-editor/src/index.ts │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ grep               │ packages/fs/tool-fs-search/src/grep.ts           │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ glob               │ packages/fs/tool-fs-search/src/glob.ts           │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ bash               │ packages/shell/tool-bash/src/index.ts            │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ bash（持久版）     │ packages/shell/tool-bash-persistent/src/index.ts │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ pwsh               │ packages/shell/tool-pwsh/src/index.ts            │
  ├────────────────────┼──────────────────────────────────────────────────┤
  │ pwsh（持久版）     │ packages/shell/tool-pwsh-persistent/src/index.ts │
  └────────────────────┴──────────────────────────────────────────────────┘

  终端 / 任务（jobs）

  ┌────────────────────────────────────────┬──────────────────────────────────────────────┐
  │                  工具                  │                   实现文件                   │
  ├────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ terminal_open / terminal_send /        │ packages/terminal/tool-terminal/src/index.ts │
  │ terminal_read / terminal_signal /      │                                              │
  │ terminal_close / terminal_list /       │                                              │
  │ user_terminal_list /                   │                                              │
  │ user_terminal_read                     │                                              │
  ├────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ job_list / job_output / job_kill       │ packages/jobs/tool-jobs/src/index.ts         │
  └────────────────────────────────────────┴──────────────────────────────────────────────┘

  子代理 / 团队（subagent / agent-team）

  工具: spawn_subagent? 实为 report
  实现文件: packages/subagent/tool-subagent-report/src/index.ts
  ────────────────────────────────────────
  工具: list_subagent_models
  实现文件: packages/subagent/tool-subagent/src/list-models.ts
  ────────────────────────────────────────
  工具: list_agents
  实现文件: packages/subagent/tool-subagent-control/src/list-agents.ts
  ────────────────────────────────────────
  工具: send_message / interrupt_agent
  实现文件: packages/subagent/tool-subagent-control/src/index.ts
  ────────────────────────────────────────
  工具: list_agents / interrupt_agent / spawn_teammate / wait_agent / team_task_create /
  team_task_get / team_task_list / team_task_update
  实现文件: packages/experimental/tool-agent-team/src/index.ts

  会话查询 / 上下文

  工具: session_search / session_event_read / session_event_search / session_event_trace /
  session_trace
  实现文件: packages/session-query/tool-session-query/src/index.ts

  目标 / 待办 / 技能 / 交互

  ┌─────────────────────────────────────┬─────────────────────────────────────────────────┐
  │                工具                 │                    实现文件                     │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ create_goal / get_goal /            │ packages/goal/tool-goal/src/index.ts            │
  │ update_goal                         │                                                 │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ todo_write                          │ packages/todo/tool-todo/src/index.ts            │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ skill                               │ packages/skill/tool-skill/src/index.ts          │
  ├─────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ ask_user_question                   │ packages/interaction/tool-ask-user/src/index.ts │
  └─────────────────────────────────────┴─────────────────────────────────────────────────┘

  扩展 / 工作流 / 网络

  ┌───────────────────────────────────────┬───────────────────────────────────────────────┐
  │                 工具                  │                   实现文件                    │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ cordis_define / cordis_inspect_list / │ packages/extensions/tool-cordis/src/index.ts  │
  │ cordis_inspect_query /                │                                               │
  │ cordis_inspect_self / cordis_run /    │                                               │
  │ cordis_stop / cordis_undefine         │                                               │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ lsp                                   │ packages/lsp/tool-lsp/src/index.ts            │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ ralph                                 │ packages/workflow/tool-ralph/src/index.ts     │
  ├───────────────────────────────────────┼───────────────────────────────────────────────┤
  │ web_fetch / web_search                │ packages/web/tool-web/src/fetch.ts、search.ts │
  └───────────────────────────────────────┴───────────────────────────────────────────────┘

packages/shell/tool-bash/src/index.ts -> ctx.tools.register(defineTool({...})
 
### 内置工具 ctx.tools @deepseek-ai/dsh-tool-*
能力域	工具包	一句话
终端	tool-bash / tool-bash-persistent / tool-pwsh / tool-pwsh-persistent / tool-terminal	跑命令、长驻会话
文件	tool-fs / tool-fs-search / tool-str-replace-editor	读写、搜索、精确编辑
网络	tool-web	web_search / web_fetch
代码	tool-lsp	跳转定义、找引用、找实现、hover
委托	tool-subagent / tool-subagent-control	把活派给子 Agent
调度	schedule	定时提醒
目标	tool-goal	会话级目标
作业	tool-jobs	后台作业输出/列表/终止
待办	tool-todo	todo_write
技能	tool-skill	加载技能
会话检索	tool-session-query	历史搜索/轨迹
提问	tool-ask-user	问用户
自省	tool-cordis	查询 Host/Client 契约，定义并管理版本化动态插件
编排	tool-workflow / tool-ralph	JS 编排、Ralph 迭代
模型可带	由各 seam 决定	呈现与调度

terminal:
ctx.bsh
ctx.bash-persistent
filesystem:
ctx.fs read / read_image / write / edit
ctx.fs_search glob / grep
ctx.str_replace_editor
ctx.attachment
delegate:
ctx.subagents subagent
ctx.subagent_control send_message / interrupt_agent / list_agents
goal:
ctx.goal get_goal / create_goal / update_goal
ctx.jobs
ctx.todo todo_write
interact:
ctx.session-query session_search/session_trace/session_event_read
ctx.userQuestions ask_user_question
ctx.schedule schedule_create
web:
ctx.web web-search web-fetch
code:
ctx.lsp goToDefinition / findReferences / goToImplementation / hover
chestrate:
ctx.cordis cordis_inspect
ctx.workflowEngine workflow
ctx.ralph
