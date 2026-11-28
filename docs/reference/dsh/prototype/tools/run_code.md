# `run_code`

## name

`run_code`

## description

模型收到的工具说明原文：

```text
Execute a TypeScript program against the available tools. Takes two required arguments: `code`, the BODY of an async function (erasable syntax only; top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Show selected text and images with inspect(...values). The program is the body of an async TypeScript function; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level await and return are supported. Use inspect(...values) to display output. Do not use console. Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution's sandbox policy. Each program starts in the Session's current directory. Running programs keep their initial directory. A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.
```

## system-section

- 段落名：`tools:ptc-only`
- 序号（section order）：`PTC_ONLY`（800）
- 注册位置：`packages/core/tool-executor-ptc/src/index.ts:29`
- 非空条件：PTC 执行器被选为当前执行器时（该段落位于执行器的 `sections` 表中，经 `tools.setExecutor` 统一注册）

原文：

```text
（模板中 `RUN_CODE_NAME` 渲染为 `run_code`）

`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.

另有 `tools:sdk`（5000）：执行器按本步可见工具生成的 TypeScript SDK 声明，`interpolate: false`。
```

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "The program: the body of an async TypeScript function."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default 120000; capped at 600000. Zero does not disable the deadline."
    },
    "sandbox_permissions": {
      "type": "string",
      "description": "Wider sandbox mode for this complete program execution; requires justification and approval.",
      "enum": [
        "workspace-write",
        "danger-full-access"
      ]
    },
    "justification": {
      "type": "string",
      "description": "Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request."
    }
  },
  "required": [
    "code",
    "description"
  ]
}
```

## result-format

返回程序输出：正文文本与 `inspect(...values)` 展示的图片块，按出现顺序排列；执行失败返回错误文本。程序内的 `tools.<name>` 子调用经过同一条受保护的执行管线，结果只进程序、不单独进入模型消息，除非程序显式输出。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合把 PTC 执行器设为当前执行器时，它是唯一可直接调用的工具。
- 嵌套调用并发上限、每分钟调用上限与超时由配置决定。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 执行器为 PTC | `tools:ptc-only` 与 `tools:sdk` 出现，全部 `tool:*` 段落失效 |
| 执行器为 native | `run_code` 不出现，`tools:ptc-only` / `tools:sdk` 也不出现 |

### 展示投影

PTC 执行器把程序输出按块呈现；嵌套子调用的 start/result 成对记录，供轨迹视图关联。

## 来源

- 包：`@deepseek-ai/dsh-tool-executor-ptc`（`reference/deepseek-harness/packages/core/tool-executor-ptc`）
