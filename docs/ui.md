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

## 目录

- [1. 界面要素 Name 与 Desc](#1-界面要素-name-与-desc)
  - [1.1 布局要素（含运行期动态节点）](#布局要素)
- [2. 包含关系](#2-包含关系)
  - [2.1 布局树（第一真值）](#布局树第一真值)
- [3. 事件回调](#3-事件回调)
  - [3.1 会话栏（shell 外）](#31-会话栏shell-外)
  - [3.2 models-modal](#32-models-modal)
  - [3.3 permissions-modal](#33-permissions-modal)
  - [3.4 user-job（运行期交互）](#34-user-job运行期交互)
- [4. 布局关系](#4-布局关系)
- [5. 元素样式](#5-元素样式)

---

## 1. 界面要素 Name 与 Desc

陈列有哪些界面要素以及简要说明各界面要素。

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
| **permissions-btn** | 权限配置按钮 → permissions-modal |
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
| **tool-call-card** | 工具调用卡片（嵌入 `model-response`）；含 tool-call-desc / approval-request / ask-user-question? / user-job-request? / action-bar? / tool-result |
| **tool-call-desc** | 工具调用描述（名称 + 入参摘要） |
| **tool-result** | 工具执行结果展示（read 默认折叠） |
| **text-file** | 文本文件工具：read / write / edit / search |
| **bash** | Bash 工具：grep / list / file / run |
| **sql** | SQL 工具：add / delete / query / insert |
| **script** | 脚本工具：run |
| **web** | Web 工具：search |
| **action-bar** | 消息/任务操作栏；附着于 `response-message` 或 `tool-call` |
| **branch-picker** | 对话分支选择器；附着于 `response-message` |
| **user-job-request** | 请求用户手动完成任务并回报结果的交互卡片（嵌入 `tool-call-card`） |
| **sub-agent-tree** | 子 Agent 执行树；在 `trajectory-tab` 内展示 |
| **agent-trace-node** | 执行树节点追踪；在 `trajectory-tab` 内展示 |
| **attachment-tray** | 附件托盘；附着于 `composer`；状态：ready / extracting / fallback |
| **trajectory-tab** | 轨迹标签页 |
| **composer** | 输入区 |
| **input-textarea** | 文本输入框 |
| **composer-footer** | 输入区底部工具栏 |
| **think-switch** | 思考模式开关 |
| **search-switch** | 联网搜索开关 |
| **add-files-btn** | 添加文件按钮 |
| **model-selector** | 模型选择器（settings-modal 内） |
| **presence-mode-switch** | 在场状态开关（composer-footer：in / out，运行时自动态，可手动切换） |
| **autonomy-mode-switch** | 自主度开关（composer-footer：supervised / autonomous，用户显式提权/降权） |
| **activity-mode-selector** | 活动选择器（composer-footer：chat / plan / build / discuss / research / review / diagnose；chat 即原 bare-chat 轻量模式） |
| **send-or-stop-btn** | 发送/停止按钮 |
| **chat-footer** | 聊天底部状态区 |
| **session-statistics** | 会话统计 |
| **token-usage** | Token 用量 |
| **context-used** | 上下文占用 |
| **context-panel** | 右侧上下文面板，展示工具详情与引用来源 |
| **permissions-modal** | 权限配置弹窗（工具档位 + bash 命令策略 + 文件写精细策略） |
| **permissions-sidebar** | 权限弹窗左侧栏（配置文件切换 + 概要） |
| **config-file-tabs** | 配置文件切换标签组 |
| **tool-permissions-tab-btn** | 工具权限标签按钮 → tool-permissions-tab（对应 permissions.json） |
| **bash-policy-tab-btn** | Bash 命令策略标签按钮 → bash-policy-tab（对应 bash-policy.json） |
| **fs-policy-tab-btn** | 文件写策略标签按钮 → fs-policy-tab（对应 fs-policy.json） |
| **permission-summary** | 权限概要区 |
| **default-tier-label** | 当前 default 档位展示（permissions.json default：allow/ask/deny） |
| **bash-rule-count-label** | bash-policy 规则条数 |
| **rule-count-label** | fs-policy 规则条数 |
| **permissions-viewport** | 权限弹窗中间内容区（随标签切换） |
| **tool-permissions-tab** | 工具权限标签页（permissions.json） |
| **tab-header** | 标签头部 |
| **tab-title** | 标签标题 |
| **default-tier-row** | default 档位行 |
| **default-tier-select** | default 档位选择（ask / allow / deny；缺省 ask） |
| **tool-permissions-table** | 工具档位表格 |
| **tool-permission-row** | 单个工具档位行（每个已声明工具一行） |
| **tool-name-label** | 工具名（registry 工具名，只读） |
| **tier-select** | 该工具档位选择（inherit / allow / ask / deny） |
| **clear-tier-btn** | 清除显式档位，回退 inherit |
| **add-tool-permission-btn** | 新增工具档位行 |
| **config-footer** | 标签页底部保存/重置栏 |
| **reset-btn** | 重置按钮（放弃未保存修改） |
| **save-btn** | 保存按钮（写回对应配置文件，经 permissions op *.upsert） |
| **bash-policy-tab** | Bash 命令策略标签页（bash-policy.json） |
| **bash-default-row** | default 档位行 |
| **bash-default-label** | default 标签 |
| **bash-default-select** | default 档位选择（固定 ask；无匹配默认 ask，fail-closed） |
| **bash-global-env** | 顶层 env：约束未在具体规则声明的 dynamic 变量（key=value* 多行） |
| **bash-rules-table** | bash 命令规则表格 |
| **bash-rule-row** | 单条命令规则行 |
| **program-input** | IR 程序名（字面；dynamic 程序为 null 不在此列） |
| **args-input** | argv 前缀精确匹配（省略表示只按程序名） |
| **decision-select** | 决策选择（allow / ask / deny） |
| **reason-input** | 可解释决策理由（回传审批 UI/日志） |
| **env-input** | dynamic 变量具体化（如 URL 白名单 / 脚本路径白名单，key=value* 多行） |
| **remove-rule-btn** | 删除规则行 |
| **add-bash-rule-btn** | 新增 bash 规则行 |
| **fs-policy-tab** | 文件写策略标签页（fs-policy.json） |
| **fs-scope-note** | 作用域说明（仅作用于 write / edit） |
| **fs-rules-table** | 文件写规则表格 |
| **fs-rule-row** | 单条 path 规则行 |
| **path-input** | 路径 glob（** 跨层 / * 单段 / ? 单字符；支持绝对或相对 workspace） |
| **permission-select** | 路径权限选择（allow / deny；先扫 deny 命中即拒） |
| **add-fs-rule-btn** | 新增 fs 规则行 |
| **permissions-panel** | 权限弹窗右侧常驻操作栏 |
| **reset-defaults-btn** | 恢复默认按钮（default=ask，清空所有显式档位与规则） |
| **close-permissions-btn** | 关闭权限弹窗按钮 |
| **settings-modal** | 设置弹窗（运行时设置：流式开关 + 供应者/模型选择） |
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
| **model-name-label** | 模型名称（存储于 providers.json 的 provider.models[].name） |
| **model-fee-badge** | 模型费用徽标（providers.json 模型 fee，缺省 "unknown"） |
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
| **save-btn** | 保存按钮（整体写回 user/providers.json，经 providers op upsert） |
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
| **reset-btn** | 重置按钮（恢复未保存修改） |
| **model-add-tab** | 新增模型标签页（需 provider_id） |
| **model-form** | 模型表单 |
| **provider-display** | 所属供应者展示（只读） |
| **fee-selector** | 费用选择器（free / paid / 自定义，默认 free；存储为 providers.json 模型 fee，缺省 "unknown"） |
| **model-edit-tab** | 编辑模型标签页 |
| **settings-panel** | 设置弹窗右侧常驻操作栏 |
| **import-config-btn** | 导入配置按钮 |
| **export-config-btn** | 导出配置按钮 |
| **danger-zone** | 危险区（可选：清空配置） |
| **close-settings-btn** | 关闭设置按钮 |

> 运行期动态节点（thought / tool-call 及其子类型 / approval-request / ask-user-question / user-job-request / action-bar / branch-picker / sub-agent-tree / agent-trace-node / attachment-tray 等）不再单列「过程要素 / 人控要素」分块，已并入上表并作为布局树的子节点呈现（见 §2 包含关系）。布局树为第一真值。

---

## 2. 包含关系 布局树（第一真值）

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
│  ├─ permissions-btn
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
│  │  │             ├─ ask-user-prompt?
│  │  │             ├─ branch-picker?
│  │  │             └─ tool-call-card*
│  │  │                 ├─ tool-call-desc
│  │  │                 ├─ approval-request
│  │  │                 ├─ ask-user-question?
│  │  │                 ├─ user-job-request?
│  │  │                 ├─ action-bar?
│  │  │                 └─ tool-result
│  │  │                 （工具类型：text-file / bash / sql / script / web）
│  │  └─ trajectory-tab
│  │     ├─ sub-agent-tree
│  │     └─ agent-trace-node
│  ├─ composer
│  │  ├─ model-http-status(on-wait|on-post|on-get)
│  │  ├─ attachment-tray
│  │  ├─ input-textarea
│  │  └─ composer-footer
│  │     ├─ think-switch
│  │     ├─ search-switch
│  │     ├─ presence-mode-switch
│  │     ├─ autonomy-mode-switch
│  │     ├─ activity-mode-selector
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
│      ├─ tree-search-input
│      ├─ add-provider-btn
│      └─ provider*                
│          ├─ provider-header
│          │  ├─ provider-collapse-toggle
│          │  ├─ provider-name-label
│          │  ├─ provider-rename-btn
│          │  ├─ provider-delete-btn
│          │  └─ add-model-btn
│          └─ model*          
│              ├─ model-name-label
│              ├─ model-fee-badge
│              ├─ model-rename-btn
│              └─ model-delete-btn
│
├─ models-viewport
│  ├─ provider-add-tab
│  │  ├─ tab-header
│  │  │  └─ tab-title
│  │  ├─ provider-form
│  │  │  ├─ name-input
│  │  │  ├─ description-input
│  │  │  ├─ baseurl-input
│  │  │  └─ apikey-input
│  │  └─ form-footer
│  │     ├─ cancel-btn
│  │     └─ save-btn
│  │
│  ├─ provider-edit-tab  
│  │  ├─ tab-header
│  │  │  └─ tab-title
│  │  ├─ provider-form
│  │  │  ├─ name-input
│  │  │  ├─ description-input
│  │  │  ├─ baseurl-input
│  │  │  ├─ apikey-input
│  │  │  ├─ fetch-row
│  │  │  │  ├─ fetch-models-btn
│  │  │  │  └─ remote-status
│  │  │  └─ remote-models-section
│  │  │     ├─ remote-toolbar
│  │  │     │  └─ add-all-btn
│  │  │     └─ remote-model-item*
│  │  │        ├─ remote-model-id
│  │  │        ├─ fee-select
│  │  │        └─ remote-add-btn
│  │  ├─ model-list-section
│  │  │  ├─ section-header
│  │  │  └─ model-item*
│  │  │     ├─ model-name-label
│  │  │     ├─ model-fee-badge
│  │  │     └─ model-edit-btn
│  │  └─ form-footer
│  │     ├─ reset-btn
│  │     └─ save-btn
│  │
│  ├─ model-add-tab    
│  │  ├─ tab-header
│  │  │  └─ tab-title
│  │  ├─ model-form
│  │  │  ├─ provider-display
│  │  │  ├─ name-input
│  │  │  ├─ description-input
│  │  │  └─ fee-selector
│  │  └─ form-footer
│  │     ├─ cancel-btn
│  │     └─ save-btn
│  │
│  └─ model-edit-tab      
│     ├─ tab-header
│     │  └─ tab-title
│     ├─ model-form
│     │  ├─ provider-display
│     │  ├─ name-input
│     │  ├─ description-input
│     │  └─ fee-selector
│     └─ form-footer
│        ├─ reset-btn
│        └─ save-btn
│
└─ models-panel
   ├─ import-config-btn
   ├─ export-config-btn
   ├─ danger-zone
   └─ close-models-btn

permissions-modal
├─ permissions-sidebar
│  ├─ config-file-tabs
│  │  ├─ tool-permissions-tab-btn
│  │  ├─ bash-policy-tab-btn
│  │  └─ fs-policy-tab-btn
│  └─ permission-summary
│     ├─ default-tier-label
│     ├─ bash-rule-count-label
│     └─ rule-count-label
├─ permissions-viewport
│  ├─ tool-permissions-tab
│  │  ├─ tab-header
│  │  │  └─ tab-title
│  │  ├─ default-tier-row
│  │  │  ├─ default-tier-label
│  │  │  └─ default-tier-select
│  │  ├─ tool-permissions-table
│  │  │  ├─ tool-permission-row*
│  │  │  │  ├─ tool-name-label
│  │  │  │  ├─ tier-select
│  │  │  │  └─ clear-tier-btn?
│  │  │  └─ add-tool-permission-btn
│  │  └─ config-footer
│  │     ├─ reset-btn
│  │     └─ save-btn
│  ├─ bash-policy-tab
│  │  ├─ tab-header
│  │  │  └─ tab-title
│  │  ├─ bash-default-row
│  │  │  ├─ bash-default-label
│  │  │  └─ bash-default-select
│  │  ├─ bash-global-env?
│  │  ├─ bash-rules-table
│  │  │  ├─ bash-rule-row*
│  │  │  │  ├─ program-input
│  │  │  │  ├─ args-input?
│  │  │  │  ├─ decision-select
│  │  │  │  ├─ reason-input?
│  │  │  │  ├─ env-input?
│  │  │  │  └─ remove-rule-btn
│  │  │  └─ add-bash-rule-btn
│  │  └─ config-footer
│  │     ├─ reset-btn
│  │     └─ save-btn
│  └─ fs-policy-tab
│     ├─ tab-header
│     │  └─ tab-title
│     ├─ fs-scope-note
│     ├─ fs-rules-table
│     │  ├─ fs-rule-row*
│     │  │  ├─ path-input
│     │  │  ├─ permission-select
│     │  │  └─ remove-rule-btn
│     │  └─ add-fs-rule-btn
│     └─ config-footer
│        ├─ reset-btn
│        └─ save-btn
└─ permissions-panel
   ├─ reset-defaults-btn
   ├─ danger-zone
   └─ close-permissions-btn

settings-modal
├─ stream-switch
├─ provider-selector
└─ model-selector

---

## 3. 事件回调

### 3.1 会话栏（shell 外）

add-workspace-btn -> folder-selector -> add-workspace(folder)
add-session-btn -> name-prompt -> add-session(worksapce,name)
models-btn -> models-modal
permissions-btn -> permissions-modal

### 3.2 models-modal

add-provider-btn -> provider-add-tab（打开新增供应者标签页）
add-model-btn(provider_id) -> model-add-tab（打开新增模型标签页，携带 provider_id）
model-edit-btn(model.id) -> model-edit-tab（打开模型编辑标签页）
save-btn(providers) -> AgentClient.call("providers", {op:"upsert", payload:<整体 providers 数组>}) -> 整体写回 user/providers.json
fetch-models-btn -> AgentClient.call("fetchModels", {baseurl, apikey}) -> remote-models-section（渲染 remote-model-item*）
remote-add-btn -> AgentClient.call("providers", {op:"upsert", payload:<整体 providers 数组>}) -> model-list-section
add-all-btn -> 对每条未添加 remote-model-item 触发 providers upsert

### 3.3 permissions-modal

save-btn(tool-permissions) -> AgentClient.call("permissions", {op:"permissions.upsert", payload:{default, tools}}) -> 写 user/permissions.json
save-btn(bash-policy) -> AgentClient.call("permissions", {op:"bashpolicy.upsert", payload:{default:"ask", rules}}) -> 写 user/bash-policy.json
save-btn(fs-policy) -> AgentClient.call("permissions", {op:"fspolicy.upsert", payload:{rules}}) -> 写 user/fs-policy.json

### 3.4 user-job（运行期交互）

user-job-request(event) -> renderUserJob(card) -> 展示任务描述 + 结果文本框 + 提交/取消按钮
  提交按钮 -> AgentClient.call("answerUserJob", {id, result}) -> 工具结果为用户回报文本
  取消按钮 -> AgentClient.call("answerUserJob", {id, cancel:true}) -> 工具结果标记为已取消
  user-job-update(event:{id,status}) -> 将对应 user-job 卡片置为已结束/已取消
---

## 4. 布局关系

shell
   children: thread-sidebar | chat-viewport | context-panel
   arrange: horizontal

thread-sidebar
   children: sidebar-header, new-session-button, workspace-session-tree-list, settings-btn
   arrange: vertical

sidebar-header
   contains: agent-badge, left-collapse-button

workspace-session-tree-list
   children: workspace*
   workspace*
      children: session*

chat-viewport
   children: chat-header, tab-body, composer, chat-footer
   arrange: vertical

chat-header
   contains: session-name, tab-icons, right-collapse-button
   tab-icons: chat-tab-icon, trajectory-icon

tab-body
   toggle: chat-tab | trajectory-tab

chat-tab
   children: request-prompt (top), model-response (bottom)
   model-response
      dynamic, order-free: thought? / answer? / ask-user-prompt? / branch-picker? / tool-call-card*

tool-call-card*
   children: tool-call-desc, approval-request, ask-user-question?, user-job-request?, action-bar?, tool-result
   user-job-request?
      trigger: request_user_job；展示任务描述 + 结果输入框，提交/取消后继续本轮
   type: text-file / bash / sql / script / web

trajectory-tab
   children: sub-agent-tree, agent-trace-node

composer
   children: attachment-tray (top, before input-textarea), input-textarea, composer-footer
   composer-footer: think-switch, search-switch, presence-mode-switch, autonomy-mode-switch, activity-mode-selector, add-files-btn, send-or-stop-btn

chat-footer
   shows: session-statistics, token-usage, context-used

context-panel
   position: right
   default: hidden
   shows: selected tool-call detail + refs

collapse
   left-collapse-button  → thread-sidebar
   right-collapse-button → context-panel

attachment
   add-files-btn → attachment-tray (states: ready / extracting / fallback)
   no AttachmentDropzone node

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