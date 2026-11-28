# `user_terminal_list`

## name

`user_terminal_list`

## description

模型收到的工具说明原文：

```text
List the terminals the user controls in the side panel beside this conversation, including terminals the user took over from you: id, title, start directory, and whether a command is running (yes | no | unknown). Runs nothing. You cannot type into these terminals; open your own with terminal_open.
```

## system-section

- 段落名：`tool:pty-panel`
- 序号（section order）：`TOOL_PTY_PANEL`（1710）
- 注册位置：`packages/experimental/terminal-panel/src/index.ts:38`
- 非空条件：侧栏终端插件挂载即贡献

原文：

```text
Terminals you open with terminal_open appear in the user's side panel. The user can watch them and type into them; once the user types into one, you can only read it, and terminal_close then only removes it from your terminal list while its shell and processes keep running for the user. Use visible terminals for long-running processes the user should see, such as dev servers and watchers; keep using bash for short commands whose output you need now. Commands in these terminals run in the session sandbox and cannot request more access; when one is denied permission, run it with bash instead. Never type passwords or one-time codes; ask the user to enter them in the terminal.
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {}
}
```

## result-format

返回用户控制的终端列表。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- `terminal-panel` 挂载时注册；`readUserTerminals: false` 时移除两个读取工具。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| `terminal-panel` 的 `readUserTerminals` 为真 | 两个用户终端工具注册，段落 `tool:pty-panel` 出现 |
| `readUserTerminals: false` | 两个工具移除 |

## 来源

- 包：`@deepseek-ai/dsh-terminal-panel`（`reference/deepseek-harness/packages/experimental/terminal-panel`）
