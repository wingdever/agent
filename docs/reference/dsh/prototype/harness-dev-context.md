# harness-dev-context（功能）

harness 自身与 Web 界面：告诉模型"当前实现副本在哪、用户正在看哪个 GUI"。它是**一个功能同时贡献 section 与 context** 的例子，规则部分见 `system-prompt.md` 与 `runtime-context.md`。

## 1 它在什么时候出现

- Web 组合装了 `dsh-harness-dev-context` 时注册；非 Web 组合不出现。
- 两个 section 在每次组装时求值；两个 context 按 `runtime-context.md` 的刷新与去重规则出现。

## 2 它注入什么

### 2.1 section

`harness:source`（10000）：

```text
The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.
```

`app:web-surface`（10100）：

```text
You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.
```

### 2.2 context

`harness:source`（200）：

```text
Current DeepSeek Harness implementation checkout: "<checkout root>".
```

`app:web-surface`（210）：

```text
Current DeepSeek Harness Web GUI URL: "<advertised url>".
```

## 3 它如何配合规则

- **section 与 context 分离**：容易变的值（路径、URL）放 context，描述性的指引放 section；这样路径或端口变化只触发快照更新，不改写系统提示词前缀。
- **不插值**：两段 section 与两份 context 都是 `interpolate: false`，避免路径里出现 `{` 被当成变量。
- **抑制**：两份 context 都是可选项，`includeRuntimeContext: false` 或 `suppressRuntimeContext()` 时消失，section 仍在。

## 4 组合条件

- 预设 persona 若 `complete: true`，两段 section 会被替换为唯一 persona，但 context 保留。
- 早期版本把路径与 URL 直接写进段落；快照会保留已被 admitted 的旧段落原文，使恢复会话时系统提示词不被重写。这一兼容投影属于会话日志的保留机制，不改变当前模板。
