以下为按“布局树为第一真值”校正后的 `ui.md`。主要处理：删除布局树中不存在的布局节点（`Header`、`debug-switch`、`Context-strip`、`Footer`、`AttachmentDropzone`）；补充布局树新增节点（`chat-tab`、`trajectory-tab`、`ask-user-prompt`、`left/right-collapse-button` 等）；统一为小写连字符命名；横切组件仅作为嵌入/展示组件，锚点必须使用布局树节点。

---

# ui.md

描述 Agent 的客户端 UI。  
名称一般采用全单词小写，并通过 `-` 连接。  
名称后紧跟 `*` 表示布局中可能包含 n 个对应节点的列表。  
名称后紧跟 `+` 表示布局中可能不固定顺序包含 n 个对应节点。  
名称后紧跟 `?` 表示布局中该界面元素可能存在或不存在。
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
| **workspace-bar** | 工作区工具条（搜索/视图/新增） |
| **search-btn** | 工作区搜索按钮 |
| **view-options-btn** | 视图选项按钮 |
| **add-workspace-btn** | 新增工作区按钮 → folder-selector |
| **workspace-session-tree-list** | 工作区/会话树列表 |
| **workspace** | 工作区节点，可重复 |
| **workspace-header** | 工作区头部 |
| **workspace-name-label** | 工作区名称 |
| **del-workspace-btn** | 删除工作区按钮 |
| **add-session-btn** | 新增会话按钮 → name-prompt |
| **session** | 会话节点，可重复 |
| **session-name-label** | 会话名称标签 |
| **rename-session-btn** | 重命名会话按钮 |
| **delete-session-btn** | 删除会话按钮 |
| **settings-btn** | 设置按钮 → settings-modal |
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
| **composer-footer** | 输入区底部工具栏 |
| **think-switch** | 思考模式开关 |
| **search-switch** | 联网搜索开关 |
| **add-files-btn** | 添加文件按钮 |
| **permission-selector** | 权限选择器 |
| **model-selector** | 模型选择器（settings-modal 内） |
| **mode-selector** | 模式选择器（composer-footer：bare-chat / turn-step / goal-plan） |
| **send-or-stop-btn** | 发送/停止按钮 |
| **chat-footer** | 聊天底部状态区 |
| **session-statistics** | 会话统计 |
| **token-usage** | Token 用量 |
| **context-used** | 上下文占用 |
| **context-panel** | 右侧上下文面板，展示工具详情与引用来源 |
| **settings-modal** | 设置弹窗（供应者/模型配置） |
| **settings-sidebar** | 设置弹窗左侧栏 |
| **provider-model-tree-list** | 供应者/模型树列表 |
| **tree-search-input** | 树过滤输入框（按名称过滤） |
| **add-provider-btn** | 新增供应者按钮 → provider-add-tab |
| **provider** | 供应者节点，可重复 |
| **provider-header** | 供应者头部（选中/展开态） |
| **provider-collapse-toggle** | 展开/折叠模型列表 |
| **provider-name-label** | 供应者名称（providers.name） |
| **provider-rename-btn** | 快捷重命名供应者 |
| **provider-delete-btn** | 删除供应者（级联删 models） |
| **add-model-btn** | 新增模型按钮 → model-add-tab |
| **model** | 模型节点，可重复（展开时渲染） |
| **model-name-label** | 模型名称（models.name） |
| **model-fee-badge** | 模型费用徽标（free/paid） |
| **model-rename-btn** | 快捷重命名模型 |
| **model-delete-btn** | 删除模型 |
| **settings-viewport** | 设置弹窗中间视口 |
| **provider-add-tab** | 新增供应者标签页 |
| **tab-header** | 标签头部 |
| **tab-title** | 标签标题 |
| **provider-form** | 供应者表单 |
| **name-input** | 名称输入框（必填） |
| **description-input** | 描述输入框（多行，选填） |
| **baseurl-input** | Base URL 输入框（URL 校验） |
| **apikey-input** | API Key 输入框（password + 显示/隐藏） |
| **form-footer** | 表单底部工具栏 |
| **cancel-btn** | 取消按钮 |
| **save-btn** | 保存按钮（INSERT / UPDATE） |
| **provider-edit-tab** | 编辑供应者标签页 |
| **fetch-row** | 功能行：拉取远端模型按钮 + 拉取状态 |
| **fetch-models-btn** | 拉取远端模型按钮（后端代理 /models，兼连通性测试） |
| **remote-status** | 拉取状态 / 错误提示 |
| **remote-models-section** | 远端模型列表区（拉取后展示） |
| **remote-toolbar** | 远端模型列表工具条（全部添加） |
| **add-all-btn** | 全部添加远端模型 |
| **remote-model-item** | 单个远端模型行 |
| **remote-model-id** | 远端模型 id |
| **fee-select** | 远端模型费用选择器（free / paid） |
| **remote-add-btn** | 将远端模型添加到本地（已添加则禁用并显示「已添加」） |
| **model-list-section** | 该供应者本地模型概览区 |
| **section-header** | 区块头部（模型 N + add-model-btn） |
| **model-item** | 单个本地模型行 |
| **model-edit-btn** | 打开模型编辑标签 |
| **provider-meta** | 供应者元信息区 |
| **created-at-label** | 创建时间（providers.created_at） |
| **updated-at-label** | 更新时间（providers.updated_at） |
| **reset-btn** | 重置按钮（恢复未保存修改） |
| **model-add-tab** | 新增模型标签页（需 provider_id） |
| **model-form** | 模型表单 |
| **provider-display** | 所属供应者展示（只读） |
| **fee-selector** | 费用选择器（free / paid / 自定义） |
| **model-edit-tab** | 编辑模型标签页 |
| **model-meta** | 模型元信息区 |
| **settings-panel** | 设置弹窗右侧常驻操作栏 |
| **import-config-btn** | 导入配置按钮 |
| **export-config-btn** | 导出配置按钮 |
| **danger-zone** | 危险区（可选：清空配置） |
| **close-settings-btn** | 关闭设置按钮 |

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

|         Name          |                Desc                       |
|         ---           |                ---                        |
| **approval-request**  | 审批请求；嵌入 `response-message`         |
| **ask-user-question** | 询问用户手动确定信息并填写答案的交互卡片  |
| **user-job-request**  | 请求用户手动完成任务并回报结果的交互卡片  |
| **action-bar**        | 消息/任务操作栏；附着于 `response-message` 或 `tool-call` |
| **branch-picker**     | 对话分支选择器；附着于 `response-message` |
| **attachment-tray**   | 附件托盘；附着于 `composer`；状态：ready / extracting / fallback |

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
│  ├─ models-btn
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
│  │  │  └─ turn*
│  │  │     └─ step*
│  │  │         ├─ agent-request?
│  │  │         │  ├─ system-prompt?
│  │  │         │  └─ user-input
│  │  │         │      ├─ chinese-primary-user-input 
│  │  │         │      └─ english-translate-user-input
│  │  │         └─ model-response
│  │  │             ├─ thought?
│  │  │             │  ├─ english-primary-thought 
│  │  │             │  └─ chinese-translate-thought
│  │  │             ├─ answer?
│  │  │             │  ├─ english-primary-answer 
│  │  │             │  └─ chinese-translate-answer
│  │  │             └─ tool-call-card*
│  │  │                 ├─ tool-call-desc
│  │  │                 ├─ ask-user-question?
│  │  │                 ├─ user-job-request?
│  │  │                 ├─ approval-request
│  │  │                 └─ tool-result
│  │  └─ trajectory-tab
│  ├─ composer
│  │  ├─ model-http-status(on-wait|on-post|on-get)
│  │  ├─ attachment-tray
│  │  ├─ input-textarea
│  │  └─ composer-footer
│  │     ├─ think-switch
│  │     ├─ search-switch
│  │     ├─ permission-selector
│  │     ├─ mode-selector
│  │     ├─ add-files-btn
│  │     └─ send-or-stop-btn
│  └─ chat-footer
│     ├─ session-statistics
│     ├─ token-usage
│     └─ context-used
└─ context-panel
```

models-modal
├─ models-sidebar
│  └─ provider-model-tree-list
│      ├─ tree-search-input                (可选：按名称过滤 provider/model)
│      ├─ add-provider-btn                 → 打开 provider-add-tab
│      └─ provider*                        (选中态 / 折叠态)
│          ├─ provider-header
│          │  ├─ provider-collapse-toggle  (展开/折叠 model 列表)
│          │  ├─ provider-name-label       (providers.name)
│          │  ├─ provider-rename-btn       (快捷重命名 → 内联编辑 name)
│          │  ├─ provider-delete-btn       (级联删除 models)
│          │  └─ add-model-btn             → 打开 model-add-tab(provider_id)
│          └─ model*                       (仅在展开时渲染)
│              ├─ model-name-label         (models.name)
│              ├─ model-fee-badge          (models.fee: free/paid)
│              ├─ model-rename-btn         (快捷重命名 → 内联编辑 name)
│              └─ model-delete-btn
│
├─ models-viewport
│  ├─ provider-add-tab
│  │  ├─ tab-header
│  │  │  └─ tab-title ("新增供应者")
│  │  ├─ provider-form
│  │  │  ├─ name-input         (必填, placeholder "qiniu", 默认值 qiniu)
│  │  │  ├─ description-input  (多行 textarea, 选填)
│  │  │  ├─ baseurl-input      (URL 校验, 例: https://api.example.com/v1)
│  │  │  └─ apikey-input       (password 输入 + 显示/隐藏切换)
│  │  └─ form-footer
│  │     ├─ cancel-btn
│  │     └─ save-btn           (提交 → INSERT providers, 成功后切到 edit-tab)
│  │
│  ├─ provider-edit-tab        (选中某个 provider)
│  │  ├─ tab-header
│  │  │  └─ tab-title ("编辑供应者")
│  │  ├─ provider-form         (字段同上, 从行内回填)
│  │  │  ├─ name-input
│  │  │  ├─ description-input
│  │  │  ├─ baseurl-input
│  │  │  ├─ apikey-input      (password + 显示/隐藏)
│  │  │  ├─ fetch-row          (功能行: 拉取远端模型 + 状态)
│  │  │  │  ├─ fetch-models-btn   (拉取远端模型: 后端代理 /models，兼连通性测试)
│  │  │  │  └─ remote-status      (拉取状态 / 错误提示)
│  │  │  └─ remote-models-section (拉取后展示远端模型列表)
│  │  │     ├─ remote-toolbar
│  │  │     │  └─ add-all-btn       (全部添加远端模型)
│  │  │     └─ remote-model-item*   (单个远端模型行)
│  │  │        ├─ remote-model-id   (远端模型 id)
│  │  │        ├─ fee-select        (free / paid)
│  │  │        └─ remote-add-btn   (添加到本地; 已添加则禁用并显示「已添加」)
│  │  ├─ model-list-section    (只读概览该 provider 下的 models)
│  │  │  ├─ section-header   ("模型 (N)" + add-model-btn)
│  │  │  └─ model-item*
│  │  │     ├─ model-name-label
│  │  │     ├─ model-fee-badge
│  │  │     └─ model-edit-btn → 打开 model-edit-tab(model.id)
│  │  ├─ provider-meta
│  │  │  ├─ created-at-label  (providers.created_at)
│  │  │  └─ updated-at-label  (providers.updated_at)
│  │  └─ form-footer
│  │     ├─ reset-btn         (恢复未保存修改)
│  │     └─ save-btn          (UPDATE providers)
│  │
│  ├─ model-add-tab            (需携带 provider_id)
│  │  ├─ tab-header
│  │  │  └─ tab-title ("新增模型")
│  │  ├─ model-form
│  │  │  ├─ provider-display   (只读: 所属 provider.name)
│  │  │  ├─ name-input         (必填, placeholder "conatus-free", 默认 conatus-free)
│  │  │  ├─ description-input  (多行 textarea, 选填)
│  │  │  └─ fee-selector       (free / paid / 自定义输入; 默认 free)
│  │  └─ form-footer
│  │     ├─ cancel-btn
│  │     └─ save-btn           (INSERT models)
│  │
│  └─ model-edit-tab           (选中某个 model)
│     ├─ tab-header
│     │  └─ tab-title ("编辑模型")
│     ├─ model-form
│     │  ├─ provider-display   (只读, 可点击跳转 provider-edit-tab)
│     │  ├─ name-input
│     │  ├─ description-input
│     │  └─ fee-selector
│     ├─ model-meta
│     │  ├─ created-at-label   (models.created_at)
│     │  └─ updated-at-label   (models.updated_at)
│     └─ form-footer
│        ├─ reset-btn
│        └─ save-btn           (UPDATE models)
│
└─ models-panel              (底部/右侧常驻操作栏, 与具体 tab 无关)
   ├─ import-config-btn        (JSON/文件导入)
   ├─ export-config-btn        (导出 providers+models, apikey 脱敏)
   ├─ danger-zone              (可选: 清空所有配置)
   └─ close-models-btn

settings-modal
├─ stream-switch
├─ provider-selector
└─ model-selector


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
├─ ask-user-question：嵌入 tool-call-card
├─ user-job-request：嵌入 tool-call-card
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
models-btn -> models-modal
fetch-models-btn -> AgentClient.call("fetchModels", {baseurl, apikey}) -> remote-models-section（渲染 remote-model-item*）
remote-add-btn -> AgentClient.call("storage", {op:"model.create", payload:{provider_id, name, fee}}) -> model-list-section
add-all-btn -> 对每条未添加 remote-model-item 触发 model.create

user-job-request(event) -> renderUserJob(card) -> 展示任务描述 + 结果文本框 + 提交/取消按钮
  提交按钮 -> AgentClient.call("answerUserJob", {id, result}) -> 工具结果为用户回报文本
  取消按钮 -> AgentClient.call("answerUserJob", {id, cancel:true}) -> 工具结果标记为已取消
  user-job-update(event:{id,status}) -> 将对应 user-job 卡片置为已结束/已取消
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
- **`user-job-request` 嵌入 `tool-call-card`**：request_user_job 工具触发，展示任务描述与结果输入框，由用户提交或取消后继续本轮。
- **`composer` 位于 `chat-viewport` 底部**：包含 `input-textarea` 与 `composer-footer`；`composer-footer` 放 `think-switch`、`search-switch`、`permission-selector`、`mode-selector`、`add-files-btn`、`send-or-stop-btn`；`attachment-tray` 附着于 `composer` 顶部（`input-textarea` 之前）。
- **`chat-footer`**：展示 `session-statistics`、`token-usage`、`context-used`。
- **`context-panel` 居右**：默认隐藏，展示选中 `tool-call` 的详情与引用来源。
- **折叠关系**：`left-collapse-button` 控制 `thread-sidebar` 折叠；`right-collapse-button` 控制 `context-panel` 折叠。
- **Process 嵌入**：`thought`、`tool-call` 显示在 `response-message` 中；`sub-agent-tree`、`agent-trace-node` 在 `trajectory-tab` 中展示。
- **HumanControl 嵌入**：`approval-request` 显示在 `response-message` 中；`action-bar`、`branch-picker` 附着在消息或工具卡片旁；`attachment-tray` 附着在 `composer` 附近。
- **附件交互**：附件上传由 `add-files-btn` 触发，附件状态通过 `attachment-tray` 展示；不单独设置 `AttachmentDropzone` 布局节点。

---

## 5. 元素样式
textcard
   line-number column
   markdown render

thought inherit textcard
answer inherit textcard

approval-request
   single-line

tool-result
   if read default collapse

user-job-request
   .user-job 卡片（复用 ask-user-question 的标题/正文/按钮样式）
   .user-job-result 多行文本框（用户填写结果报告）
   提交/取消按钮分别对应 btn-approve / btn-deny