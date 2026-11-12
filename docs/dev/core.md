# core 模块构成与调用关系

`core` 是 Agent 的后端核心（CommonJS，Node 运行）。M0 重构把原本集中在 `index.js` 的 `AgentCore` 拆为多个独立模块：类只保留「转发壳」，对外接口（`createCore` 返回的 `core` 对象、`chat`、事件）完全不变。

## 1. 文件构成

```mermaid
graph TD
    subgraph AgentCore["AgentCore（对外接口不变）"]
        IDX["index.js<br/>AgentCore 类 + 转发壳<br/>createCore / chat / handleCall"]
    end

    subgraph M0拆分["M0 拆出的 4 个模块"]
        STREAM["model-call.js<br/>stream / emitUsage"]
        USERIN["user-input/<br/>prepareUserInput<br/>(user-references)"]
        TANCHOR["token-anchor.js<br/>recordTokenAnchor"]
        CRUN["compaction-runner.js<br/>surfaceNodes / requestMessages / summarizeMessages<br/>pruneToolResults / runCompaction / compactSession<br/>maybeCompactStep / resolveContextWindow"]
    end

    subgraph 既有依赖["既有核心模块（M0 未改）"]
        COMP["compaction.js<br/>压缩检查/落库"]
        TMETER["token-meter.js<br/>anchorFrom"]
        BCHAT["bare-chat.js<br/>runBareChat"]
        TRANS["translation.js"]
        SYSP["system-prompt.js"]
        PERM["permissions.js / fs-policy.js"]
        LOOPS["loops/loops-config.js"]
        LINEAR["loops/linear.js<br/>loops/resolve-input"]
    end

    IDX -->|require + 转发| STREAM
    IDX -->|require + 转发| TANCHOR
    IDX -->|require + 转发| CRUN
    LINEAR -->|调用| USERIN

    CRUN -->|调用| STREAM
    CRUN -->|调用| COMP
    STREAM -->|用量累计| TMETER
    TANCHOR -->|锚点计算| TMETER
    IDX --> BCHAT
    IDX --> TRANS
    IDX --> SYSP
    IDX --> PERM
    IDX --> LOOPS
```

## 2. 调用关系（M0 转发链路）

`index.js` 把原 `_stream` / `_emitUsage` / `_recordTokenAnchor` / 压缩系列方法改造为转发壳，调用方（cli / web api / tests）拿到的 `core` 对象行为与拆分前一致。引用解析已从 `core` 上摘除，独立为 `core/user-input`（由 `prepareUserInput` 收口两条 loop 路径的输入准备），不再挂在 `core` 上。

```mermaid
sequenceDiagram
    participant Caller as 调用方(chat API)
    participant Core as index.js AgentCore
    participant CR as compaction-runner
    participant SM as stream
    participant RF as user-input (prepareUserInput)
    participant TA as token-anchor
    participant CM as compaction(既有)

    Caller->>Core: chat(messages, sessionId, ...)
    Core->>Core: _runLoop(...)
    Core->>RF: prepareUserInput(core, ctx)
    RF-->>Core: pendingRefs[]
    Core->>SM: stream(core, opts)
    SM-->>Core: SSE 事件流(token/usage/...)
    Core->>TA: recordTokenAnchor(core, opts)
    TA-->>Core: token 锚点
    Note over Core,CM: 自动压缩压力触发
    Core->>CR: maybeCompactStep(core, opts)
    CR->>CR: surfaceNodes / requestMessages / summarizeMessages
    CR->>CM: 压缩检查与落库
    CR->>SM: stream(core, opts) 摘要生成
    CR-->>Core: 压缩完成
    Core-->>Caller: 事件流结束 / 响应
```

## 3. 拆分要点

- **纯转发，接口不变**：`createCore` 返回的 `core` 对象结构、`chat`、`handleCall`、`requestApproval`、`requestUserQuestion` 未动；`compaction-runner` 通过 `core._selectTools()` / `core._toolDefs()` / `core._resolveTarget()` 回调类内方法，避免循环依赖。
- **流式与用量**：`model-call.js` 的 `emitUsage` 是纯函数（由 `core.usageState` 聚合），`stream` 调用 `core._post` / `core.reasoningParamFor` / `core.effort` / `core.model` / `core.baseUrl`。
- **压缩自治**：`compaction-runner` 自带 `resolveContextWindow`（不 import `index.js`），仅向上发 `compaction` 事件，由 UI 层（`compaction-ui.js`）呈现。
- **token 锚点**：`token-anchor.js` 仅依赖 `token-meter.anchorFrom`，与对话循环解耦。
