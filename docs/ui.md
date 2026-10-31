以下为按“布局树为第一真值”校正后的 `ui.md`。主要处理：删除布局树中不存在的布局节点（`Header`、`mode-selector`、`debug-switch`、`Context-strip`、`Footer`、`AttachmentDropzone`）；补充布局树新增节点（`chat-tab`、`trajectory-tab`、`ask-user-prompt`、`left/right-collapse-button` 等）；统一为小写连字符命名；横切组件仅作为嵌入/展示组件，锚点必须使用布局树节点。

---

# ui.md

描述 Agent 的客户端 UI。  
名称一般采用全单词小写，并通过 `-` 连接。  
名称后紧跟 `*` 表示布局中可能包含 n 个对应节点的列表。  
名称后紧跟 `+` 表示布局中可能不固定顺序包含 n 个对应节点。  
**布局树为第一真值；其它部分与布局树冲突时，以布局树为准。**

---

## 1. 界面要素 Name 与 Desc

### 布局要素

| Name | Desc |
|---|---|
| **shell** | 整体界面外壳 |
| **thread-sidebar** | 左侧会话栏 |
| **sidebar-header** | 会话栏头部 |
| **agent-badge** | 当前 Agent 标识 |
| **left-collapse-button** | 左侧会话栏折叠按钮 |
| **new-session-button** | 新建会话按钮 |
| **workspace-session-tree-list** | 工作区/会话树列表 |
| **workspace** | 工作区节点，可重复 |
| **session** | 会话节点，可重复 |
| **settings-btn** | 设置按钮 |
| **chat-viewport** | 中间聊天主视口 |
| **chat-header** | 聊天头部 |
| **session-name** | 当前会话名 |
| **tab-icons** | 标签图标组 |
| **chat-tab-icon** | 聊天标签图标 |
| **trajectory-icon** | 轨迹标签图标 |
| **right-collapse-button** | 右侧面板折叠按钮 |
| **tab-body** | 标签内容区 |
| **chat-tab** | 聊天标签页 |
| **request-prompt** | 用户请求/提示词 |
| **response-message** | Agent 响应消息 |
| **approval-request** | 审批请求 |
| **ask-user-question** | 向用户提问 |
| **thought** | 思考过程 |
| **tool-call** | 工具调用 |
| **answer** | 最终回答 |
| **ask-user-prompt** | 向用户展示的追问/提示 |
| **trajectory-tab** | 轨迹标签页 |
| **composer** | 输入区 |
| **input-textarea** | 文本输入框 |
| **cancel/stop-btn** | 取消/停止按钮 |
| **composer-footer** | 输入区底部工具栏 |
| **add-file-btn** | 添加文件按钮 |
| **permission-selector** | 权限选择器 |
| **model-selector** | 模型选择器 |
| **send-btn** | 发送按钮 |
| **chat-footer** | 聊天底部状态区 |
| **session-statistics** | 会话统计 |
| **token-usage** | Token 用量 |
| **context-used** | 上下文占用 |
| **context-panel** | 右侧上下文面板，展示工具详情与引用来源 |

### 过程要素（横切，非布局树节点）

| Name | Desc |
|---|---|
| **thought** | 推理链/思考过程展示；嵌入 `response-message` |
| **tool-call** | 工具调用卡片；嵌入 `response-message` |
| **text-file** | 文本文件工具：read / write / edit / search |
| **bash** | Bash 工具：grep / list / file / run |
| **sql** | SQL 工具：add / delete / query / insert |
| **script** | 脚本工具：run |
| **web** | Web 工具：search |
| **sub-agent-tree** | 子 Agent 执行树；在 `trajectory-tab` 内展示 |
| **agent-trace-node** | 执行树节点追踪；在 `trajectory-tab` 内展示 |

### 人控要素（横切，非布局树节点）

| Name | Desc |
|---|---|
| **approval-request** | 审批请求；嵌入 `response-message` |
| **action-bar** | 消息/任务操作栏；附着于 `response-message` 或 `tool-call` |
| **branch-picker** | 对话分支选择器；附着于 `response-message` |
| **attachment-tray** | 附件托盘；附着于 `composer`；状态：ready / extracting / fallback |

---

## 2. 包含关系

### 布局树（第一真值）

```text
shell
├─ thread-sidebar
│  ├─ sidebar-header
│  │  └─ agent-badge
│  ├─ new-session-button
│  ├─ workspace-bar
│  │  ├─ search-btn
│  │  ├─ view-options-btn
│  │  └─ add-workspace-btn
│  ├─ workspace-session-tree-list
│  │  └─ workspace*
│  │      ├─ workspace-header
│  │      │  ├─ workspace-name-label
│  │      │  ├─ del-workspace-btn
│  │      │  └─ add-session-btn
│  │      └─ session*
│  │          ├─ session-name-label
│  │          ├─ rename-session-btn
│  │          └─ delete-session-btn
│  └─ settings-btn
├─ chat-viewport
│  ├─ chat-header
│  │  ├─ left-collapse-button
│  │  ├─ session-name
│  │  ├─ tab-icons
│  │  │   ├─ chat-tab-icon
│  │  │   └─ trajectory-icon
│  │  └─ right-collapse-button
│  ├─ tab-body
│  │  ├─ chat-tab
│  │  │  ├─ request-prompt
│  │  │  └─ response-message
│  │  │     ├─ approval-request+
│  │  │     ├─ ask-user-question+
│  │  │     ├─ thought+
│  │  │     ├─ tool-call+
│  │  │     ├─ answer+
│  │  │     └─ ask-user-prompt+
│  │  └─ trajectory-tab
│  ├─ composer
│  │  ├─ input-textarea
│  │  ├─ cancel/stop-btn
│  │  └─ composer-footer
│  │     ├─ add-file-btn
│  │     ├─ permission-selector
│  │     ├─ model-selector
│  │     └─ send-btn
│  └─ chat-footer
│     ├─ session-statistics
│     ├─ token-usage
│     └─ context-used
└─ context-panel
```

### 横切组件

```text
Process（非布局树节点）
├─ thought：嵌入 response-message
├─ tool-call：嵌入 response-message
│  ├─ text-file：read / write / edit / search
│  ├─ bash：grep / list / file / run
│  ├─ sql：insert / delete / query / select
│  ├─ script：run
│  └─ web：search
└─ trajectory-tab 内展示
   ├─ sub-agent-tree
   └─ agent-trace-node

HumanControl（非布局树节点）
├─ approval-request：嵌入 response-message
├─ action-bar：附着 response-message / tool-call
├─ branch-picker：附着 response-message
└─ attachment-tray：附着 composer
   └─ 状态：ready / extracting / fallback
```

> `Process` 和 `HumanControl` 不是 `shell` 的布局子节点，而是嵌入在 `response-message`、`tool-call`、`trajectory-tab` 和 `composer` 附近的横切组件。

---

## 3. 事件回调

add-workspace-btn -> folder-selector -> add-workspace(folder)
add-session-btn -> name-prompt -> add-session(worksapce,name)
---

## 4. 布局关系

- **整体三栏**：左侧 `thread-sidebar`，中间 `chat-viewport`，右侧 `context-panel`。
- **`thread-sidebar` 纵向排列**：`sidebar-header` → `new-session-button` → `workspace-session-tree-list` → `settings-btn`。
- **`sidebar-header`**：展示 `agent-badge` 和 `left-collapse-button`。
- **`workspace-session-tree-list`**：包含可重复的 `workspace`，每个 `workspace` 下包含可重复的 `session`。
- **`chat-viewport` 纵向排列**：`chat-header` → `tab-body` → `composer` → `chat-footer`。
- **`chat-header`**：包含 `session-name`、`tab-icons` 和 `right-collapse-button`；`tab-icons` 包含 `chat-tab-icon` 与 `trajectory-icon`。
- **`tab-body`**：在 `chat-tab` 与 `trajectory-tab` 之间切换。
- **`chat-tab` 内部**：`request-prompt` 在上，`response-message` 在下；`response-message` 内按需渲染 `approval-request`、`ask-user-question`、`thought`、`tool-call`、`answer`、`ask-user-prompt`，顺序不固定。
- **`composer` 位于 `chat-viewport` 底部**：包含 `input-textarea`、`cancel/stop-btn` 和 `composer-footer`；`composer-footer` 放 `add-file-btn`、`permission-selector`、`model-selector`、`send-btn`。
- **`chat-footer`**：展示 `session-statistics`、`token-usage`、`context-used`。
- **`context-panel` 居右**：默认隐藏，展示选中 `tool-call` 的详情与引用来源。
- **折叠关系**：`left-collapse-button` 控制 `thread-sidebar` 折叠；`right-collapse-button` 控制 `context-panel` 折叠。
- **Process 嵌入**：`thought`、`tool-call` 显示在 `response-message` 中；`sub-agent-tree`、`agent-trace-node` 在 `trajectory-tab` 中展示。
- **HumanControl 嵌入**：`approval-request` 显示在 `response-message` 中；`action-bar`、`branch-picker` 附着在消息或工具卡片旁；`attachment-tray` 附着在 `composer` 附近。
- **附件交互**：附件上传由 `add-file-btn` 触发，附件状态通过 `attachment-tray` 展示；不单独设置 `AttachmentDropzone` 布局节点。