# 终端面板（User Terminal）

状态：第一版实现（2026-11-25）。目标是 DSH 的 User Terminal 语义：终端页有真实终端、用户可新建和接管、agent 只能读不能写、全屏 TUI 接近原生。

## 界面落位

终端是主视图的一页（`ui/web/index.html` 的 `terminal-page`），入口在左栏会话组，与聊天/轨迹并列。终端按 `session_id` 过滤，只显示当前会话的终端；无会话时页面显示空态。切换其它主视图时页面隐藏，但 WebSocket 与终端进程保持，xterm 继续写入原始字节；尺寸拟合与聚焦只在页面可见时执行，隐藏终端不抢焦点。Agent 新建终端只提示，不自动切页。

## 数据模型

`lib/terminals/index.js` 的 `InteractiveTerminal` 增加四个状态：

| 字段 | 含义 |
|---|---|
| `createdBy` | `agent`（`terminal_open` 创建）或 `user`（侧栏新建） |
| `control` | 当前可写方；`agent` 只能 `terminal_send` / `terminal_signal`，用户只能通过面板/WS 输入 |
| `detached` | agent 执行 `terminal_close` 后但仍归侧栏使用的终端 |
| `screen` | `lib/terminals/screen.js` 的 headless xterm，维护渲染后的 active buffer |

`control` 的切换是不可逆的：浏览器第一次发送二进制键盘帧时，服务端在 `input()` 内调用 `takeOver()`，把 `control` 设为 `user`。之后：

- `terminal_send` / `terminal_signal` 抛错，agent 不能偷偷改用户正在操作的终端。
- `terminal_close` 只 detach，不调用 `close()`；shell 和进程继续运行。
- `terminal_list` 隐藏 `createdBy=user` 和 `detached=true`；`user_terminal_list` 只列 `control=user` 的终端。
- `terminal_read` 对 `createdBy=user` 返回错误，避免 agent 绕过 user_terminal 语义读用户终端；用户接管的 agent 终端仍可被 `terminal_read` 读。
- 终端页标签的关闭按钮调用 `terminal.panel.close`，走 `actor=user`，真正 kill 进程树。

## 屏幕模型

PTY 的原始字节同时进入两处：

1. `output` 环：保留最近 200 KiB 纯文本，服务 `terminal_read`（旧工具契约）。
2. `TerminalScreen`：`@xterm/headless` 按顺序解析所有字节，active buffer 是权威屏幕。

`@xterm/headless` 是 CommonJS，ESM 里必须默认导入再解构 `Terminal`。`@xterm/addon-serialize` 同样按默认导入。每次 `write` 通过 promise 链串行化，`snapshot()` / `readScreen()` 先 `flush` 再读，避免异步解析导致读到上一帧。

- `snapshot()`：`SerializeAddon.serialize({scrollback:2000})`，带回 `seq`。快照包含颜色、光标、alternate buffer 等状态。
- `readScreen(lines)`：从 active buffer 取最近 N 行，`translateToString(true)` 去右侧空白；尾部空行去掉；空屏返回 `(no output)`。
- prompt 私有 sentinel（`PS1` 的 `\x1e...:P\x1f`）在进入屏幕/订阅者之前就剥掉，防止 `user_terminal_read` 或 UI 看到内部标记。

`resize` 时先等屏幕写入清空，再 `xterm.resize`，最后 `pty.resize`；两边尺寸始终一致。

## WebSocket 协议

端点复用 HTTP transport 的端口：

```text
ws://127.0.0.1:<port>/terminal?sessionId=<id>&terminalId=<term_id>&cols=<n>&rows=<n>
```

只支持 `AGENT_TRANSPORT=http`；`ipc` transport 不挂载终端页，也不默认下发 `user_terminal_*`。

服务端连接流程：

1. 校验 `sessionId` / `terminalId`，从 `TerminalService` 找终端。
2. `resize(cols, rows)`。
3. 先订阅 PTY 输出到本地 `pending`，再 `snapshot()`；`hello` 发送后才开启实时输出。
4. `hello` 是文本 JSON：

```json
{
  "type": "hello",
  "terminalId": "term_...",
  "seq": 12,
  "snapshot": "\u001b[...",
  "cols": 90,
  "rows": 25,
  "control": "agent",
  "createdBy": "agent",
  "alive": true,
  "running": "no"
}
```

5. `pending` 中 `seq <= hello.seq` 的块已经包含在快照里，丢弃；`seq > hello.seq` 的块按顺序补发。这样不会因为快照期间的新输出丢字节，也不会重复。

之后：

- 服务端 → 客户端：二进制帧，PTY 原始输出。
- 客户端 → 服务端：二进制帧，原始键盘字节。xterm 的 `onData` 输出什么就发什么，不追加 Enter、不做行编辑。
- 文本控制帧：`{"type":"resize","cols","rows"}`、`{"type":"ping"}`；服务端回 `pong`。
- 终端退出：`{"type":"exit","exitCode":...}`，随后关闭连接。
- 错误：`{"type":"error","error":"..."}`。

## 背压与重连

`ws.bufferedAmount > 1 MiB` 时调用 node-pty 的 `pause()`；50ms 轮询，降到 256 KiB 以下 `resume()`。不丢字节。

客户端断开不杀终端。重连时重新走 hello 快照；浏览器先 `term.reset()` 再写快照。终端页隐藏时 socket 保持连接、xterm 继续写入；页面可见时重新拟合尺寸并聚焦，不因切页重连。

## 终端页 RPC

| RPC | 参数 | 行为 |
|---|---|---|
| `terminal.panel.list` | `{session_id}` | 返回当前会话所有侧栏终端，含 `createdBy` / `control` / `detached` / `running` / `cwd` |
| `terminal.panel.open` | `{session_id, name?, cwd?, cols?, rows?}` | 以 `createdBy=user` 创建终端；`cwd` 缺省用会话 workspace，再回退 `process.cwd()` |
| `terminal.panel.close` | `{session_id, id}` | 用户关闭按钮，真正 kill 进程树 |

UI 是 `ui/web/terminal-panel.js`，xterm 资源从 `node_modules/@xterm/xterm` 和 `@xterm/addon-fit` 复制到 `ui/web/vendor/`，没有 bundler。

## 工具契约

- `user_terminal_list`：无参数，返回 `id`、名称、`cwd`、`running=yes|no|unknown`（按 `/proc/<shell>/stat` 的前台进程组：shell 自己为 no，子进程组为 yes，读取失败为 unknown）；只读。
- `user_terminal_read`：`{id, lines?}`，默认 500、上限 2000；只读渲染屏幕。
- 两个工具共用 `tool:pty-panel`（order 1710）；`AGENT_TERMINAL_PANEL=0` 或 IPC 时从默认可见集合移除。
- 不提供 `user_terminal_send`：模型不能向用户终端输入，输入只来自 UI RPC/WebSocket。

## 明确不做（第一版）

- 跨进程持久化、应用重启后的终端恢复、SSH、Windows shell。
- 终端面板的 IPC 流式桥。
- 向用户终端注入密码/验证码；需要用户自己在面板输入。
