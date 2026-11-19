# persona（功能）

部署 persona：注入身份、人格与回答策略。它只负责**贡献两个 section**，规则部分见 `system-prompt.md`。

## 1 它在什么时候出现

- 由部署配置或 agent 预设提供，随组合加载即注册，不随会话状态变化。
- 两个 section 在**每次组装**时求值；文本为空时按渲染规则被丢弃，不会出现在系统提示词里。
- `dsh-persona` 的 `complete: true` 会让前缀成为**唯一** section（见 `system-prompt.md` 的 complete 规则）。

## 2 它注入什么

两个 section，都是静态文本（可含 `{model}` 等变量）：

| 段落 | 序号 | 提供者 | 默认 |
|---|---|---|---|
| `deployment:persona-prefix` | 0 | `dsh-system-prompt` 配置 / `dsh-persona` | 空 |
| `deployment:persona-suffix` | 10200 | 同上 | 空 |

### 2.1 前缀

前缀为部署或预设提供的模板，典型值：

典型值：

```text
You are a coding agent powered by the {model} model.
```

```text
You are a coding assistant powered by the {model} model. Your bash tool runs under a file sandbox — a `[sandbox: file access denied …]` result is policy, not a command bug.

Verify your work by running the code or tests. Keep answers brief and factual.
```

### 2.2 后缀

默认为空。有值时出现在所有工具指引与变量之后、harness 来源之前（10200）。引用 `{cwd}` 的旧模板已不可用，会以「未知变量」使组装失败。

### 2.3 身份

身份段（`harness:identity`，-1000）由 `dsh-system-prompt` 固定提供，与 persona 并列：

```text
You are an AI agent powered by DeepSeek Harness.
```

`includeHarnessIdentity: false` 时省略，供只由兼容层拥有完整系统提示词的部署使用。

## 3 它如何配合规则

- **排序**：前缀 `DEPLOYMENT_PERSONA_PREFIX`（0），后缀 `DEPLOYMENT_PERSONA_SUFFIX`（10200），都取中心分配序号。
- **遮蔽**：预设通过注册同名 section 覆盖部署默认值，这是作用域遮蔽的标准用法（见 `system-prompt.md`）。
- **抑制**：`dsh-persona` 的 `includeRuntimeContext: false` 走 `suppressRuntimeContext()`，配合 `runtime-context.md` 的抑制规则。
- **插值**：默认插值；`{model}` 由 agent-loop 提供，`{cwd}` 不可用。

## 4 组合条件

- 预设内 persona 与全局 persona 同名时，预设胜出。
- `complete: true` 时其余 section 全部失效，但 context 与工具不受影响。
- 与 `harness-dev-context` 同处时，其两段（`harness:source`、`app:web-surface`）排在 persona 之后。
