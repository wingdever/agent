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
  - [3.5 loops-modal](#35-loops-modal)
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
| **workspace-bar** | 工作区工具条（搜索/视图/新增/回收站 + 搜索输入框） |
| **search-btn** | 工作区搜索按钮：切换搜索输入框，按会话名过滤 `session-item` |
| **search-input** | 会话名过滤输入框（hidden 默认，点击 search-btn 显示） |
| **trash-btn** | 回收站按钮：切换 `deleted-sessions-list` 已软删会话视图 |
| **deleted-sessions-list** | 回收站：列出 `deleted_at` 非空的会话，提供 恢复 / 彻底删除 |
| **view-options-btn** | 视图选项按钮 |
| **add-workspace-btn** | 新增工作区按钮 → folder-selector |
| **workspace-session-tree-list** | 工作区/会话树列表（仅未软删会话） |
| **workspace** | 工作区节点，可重复 |
| **workspace-header** | 工作区头部 |
| **workspace-name-label** | 工作区名称 |
| **del-workspace-btn** | 删除工作区按钮 |
| **add-session-btn** | 新增会话按钮 → name-prompt |
| **session** | 会话节点，可重复 |
| **session-name-label** | 会话名称标签 |
| **rename-session-btn** | 重命名会话按钮 |
| **delete-session-btn** | 删除会话按钮（软删除：标记 deleted_at，保留历史，可从回收站恢复） |
| **restore-session-btn** | 回收站内：恢复已软删会话（清除 deleted_at） |
| **purge-session-btn** | 回收站内：彻底删除（hard 删，不可恢复） |
| **permissions-btn** | 权限配置按钮 → permissions-modal |
| **loops-btn** | 循环编排按钮 → loops-modal |
| **settings-btn** | 设置按钮 → settings-modal |
| **chat-viewport** | 中间聊天主视口 |
| **chat-header** | 聊天头部；两段式布局：左组贴左（left-collapse-button + session-name，普通布局包裹、无 data-name），右组 `header-controls-group` 由 `margin-left:auto` 靠右；中间为弹性空白 |
| **session-name** | 当前会话名（左组，尽量完整展开不省略；空间不足时挤压右组） |
| **header-controls-group** | 聊天头部右侧控件组（chat-header：靠右合并容器，含 session-mode-indicator / activity-indicator / presence-mode-switch / autonomy-mode-switch / tab-icons / right-collapse-button；由 margin-left:auto 推到右侧；空间不足时切紧凑样式，见 app.js 的 ResizeObserver） |
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
| **trajectory-tab** | 轨迹标签页：按 turns → steps → (messages + calls) 渲染会话轨迹时间线（思考可展开、工具调用点击联动 context-panel）；详见 `docs/dsh/plan-trajectory.md` |
| **composer** | 输入区 |
| **input-textarea** | 文本输入框 |
| **composer-footer** | 输入区底部工具栏（DSH 风格：思考/搜索/权限预设/model-effort/@/发送） |
| **think-switch** | 思考模式开关；由设置 `reasoningControl` 决定是否在 composer 显示（与 `effort-selector` 二选一）。开启=默认推理（不发送 effort 参数），关闭→透传 core `effort:"off"`（thinking disabled） |
| **search-switch** | 联网搜索开关 |
| **permission-selector** | 权限预设选择器（composer-footer）：`read-only`(只读工具 allow，其余 deny) / `workspace-write`(只读+工作区写 allow，其余 deny) / `full-access`(全 allow) / `fine-grained`(沿用 user/* 配置，点击打开权限 modal) |
| **model-effort-selector** | 模型+推理等级组合选择器，含两个子选择器 `model-selector` 与 `effort-selector`；`effort-selector` 的可见性由 `reasoningControl` 设置控制 |
| **model-selector** | 模型选择器（composer-footer，按 provider 标题用 `<optgroup>` 分组；选中持久化到 settings.model；同时 settings-modal 内仍有独立入口）（选中跨 provider 的模型应同步切换 settings.provider 以对齐凭据；模型配置变更后应重新同步下拉列表） |
| **effort-selector** | 推理等级选择器（仅当 `reasoningControl==="effort-selector"` 时显示）；选项由 `modelCapabilities` RPC 获取——优先读 `user/providers.json` 缓存的 `effort.supported_levels`，缺失时回退网络（`effort.supported_levels` / `model_spec.capabilities.reasoningEffortOptions`），再兜底 `low/medium/high`；列表首位固定为 `off`（关闭推理）。选中持久化到 settings.effort 并透传 core：`off`→`{"thinking":{"type":"disabled"}}`，其余→`{"reasoning_effort":"<level>"}` |
| **reasoningControl 设置** | settings-modal 中的「推理参数控件」下拉：`effort-selector` / `think-switch` 二值，持久化到 `settings.reasoningControl`（默认 `think-switch`）。决定 composer 渲染哪个推理控件——二者语义冲突（都向模型注入推理参数），只能显示一个 |
| **ref-btn** | `@` 引用按钮：打开引用菜单（历史会话 / 本地文件），选中的引用以 chip 展示于 `ref-chips` |
| **ref-chips** | 引用 chip 容器（hidden 默认，有引用时显示），每个 chip 可单独移除 |
| **ref-chip** | 单个引用 chip（`ref-file` / `ref-session` 修饰），含移除按钮 |
| **presence-mode-switch** | 在场状态开关（**chat-header**：in / out，运行时自动态，可手动切换） |
| **autonomy-mode-switch** | 自主度开关（**chat-header**：supervised / autonomous，用户显式提权/降权） |
| **activity-indicator** | 当前活动指示器（chat-header：点击打开切换菜单；显示 `活动: <当前活动>` 与完成态 `✓`；建会话时选定初始活动，运行后可自然流转或强制切换（未完成强制切需二次确认））。取值（7）：goal-plan / build-code / discuss-doc / research / review-proj / human-learn / diagnose，默认 `research`。注：`bare-chat` 不是 activity 取值，而是会话模式（session mode：bare = 未选会话 / persisted = 选中会话），由 `currentSessionId` 派生，见 `docs/agent-mode.md` 会话模式层 |
| **session-mode-indicator** | 会话模式指示器（chat-header，只读；显示 `模式: bare-chat` / `模式: turn-step`，附 `data-mode` 着色与 title 说明；由 `currentSessionId` 派生 `getSessionMode()`，不提供切换，进入方式仍为「不选/选会话」） |
| **send-or-stop-btn** | 发送/停止按钮 |
| **chat-footer** | 聊天底部状态栏（DSH 风格三段；活动/权限/自主度由各自控件承载，不重复） |
| **session-statistics** | 左段：`⟳ N turns M steps · K tok/s`（图标 + 会话累计 turns/steps + 最近一轮 TPS，turns/steps 间空格） |
| **token-usage** | 中段：`▤ X.XM tok · Cache hit NN%`（图标 + total tokens 人类可读 + 缓存命中率） |
| **context-used** | 右段：SVG donut（track + 动态 fill 弧）+ `NN%` 文本，按占上下文窗口估算占比实时更新。窗口经 `contextWindow` RPC 解析：providers.json 每模型 `context_window` > settings.contextWindow > 128000（与自动压缩阈值同源） |
| **compaction-card** | 聊天区 checkpoint 卡：按最新 `compaction/summary` 事件的 `boundaryMessageId` 插在**边界消息之后**（切点可能落在 turn 内部；找不到消息时退回 `boundaryTurnSeq` 的 turn 末尾）；标题显示压缩 turn 数 / `~tokensBefore → ~tokensAfter` / 边界 message / 模型 / 时间，正文为模型写的 8 段 summary（默认展开；preamble 与 `<compacted-summary>` 标签只给模型看，卡片不显示）。原始 turns/steps 仍然全部展示（DSH transcript 语义），卡片只标出模型视角被替换的位置 |
| **compaction-notice** | 压缩状态提示行（`compaction` 事件驱动）：start / prune / overflow / done / failed 的短文案，压缩完成后由重建的会话视图与 checkpoint 卡取代 |
| **/compact 斜杠命令** | composer 输入以 `/` 开头时在发送前拦截：`/compact`（无参数）触发手动压缩；bare-chat 提示不可用；未知命令提示可用命令。不进入对话历史 |
| **auto-compact 设置** | settings-modal 的「自动压缩」开关（`settings.autoCompact`，默认开）：开启后每个 step 请求前按窗口 80% 检查压力，先裁剪超长 tool result，仍超限则写 checkpoint；关闭后只剩手动 `/compact` |
| **traj-compactions / traj-compaction** | 轨迹面板顶部的压缩标记列表（summary 事件的 trigger / 边界 turn / turns / token 变化）；原始 turns/steps 仍完整保留 |
| **context-panel** | 右侧上下文面板：**产物预览**（`#artifactPreview`，写文件类工具「预览」按钮触发，按扩展名渲染 md/html/图片/代码 + 在编辑器打开）+ 工具检视器（`#contextDetail`，点击 tool-call 看参数/结果） |
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
| **loops-modal** | 循环编排弹窗（节点拓扑 + hooks 覆写编辑） |
| **loops-sidebar** | 循环弹窗左侧栏（概要） |
| **loops-summary** | 循环概要区（当前引擎、节点数、loop 边数） |
| **current-engine-label** | 当前引擎展示（只读；显示 `AGENT_LOOP_ENGINE` 值，标注「重启生效」；不提供引擎切换） |
| **loops-viewport** | 循环弹窗中间视口 |
| **loop-topology** | 左侧只读拓扑：静态 `next` 链 + `decide-next→auto-compact` 回环 + 实时 hooks 虚线指向 target 节点 |
| **loop-nodes-table** | 右侧可编辑节点表 |
| **loop-node-row*** | 单个节点行（core + builtin 均展示） |
| **loop-node-id-label** | 节点 id（只读） |
| **loop-node-type-label** | 节点类型（只读） |
| **loop-next-label** | `next` 指向（只读；`next` 不可编辑） |
| **loop-hooks-editor** | hooks 编辑器（唯一可编辑区域） |
| **hook-slot*** | 单条 hook（on/slot/target 三元组） |
| **hook-add-btn** | 新增 hook 行 |
| **hook-target-select** | hook target 下拉（列出所有节点 id：core + builtin） |
| **hook-remove-btn** | 删除 hook 行 |
| **loops-panel** | 循环弹窗右侧常驻操作栏 |
| **close-loops-btn** | 关闭循环弹窗按钮 |
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
| **remote-models-section** | 远端模型列表区（拉取后展示）；含 `remote-model-response`（展示远端原始响应：HTTP 状态 + 报文，成功/失败均写入，便于排查） |
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

> 运行期动态节点（thought / tool-call 及其子类型 / approval-request / ask-user-question / user-job-request / action-bar / branch-picker / sub-agent-tree / agent-trace-node 等）不再单列「过程要素 / 人控要素」分块，已并入上表并作为布局树的子节点呈现（见 §2 包含关系）。布局树为第一真值。

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
│  │  ├─ search-input
│  │  ├─ view-options-btn
│  │  ├─ add-workspace-btn
│  │  └─ trash-btn
│  ├─ workspace-session-tree-list
│  ├─ deleted-sessions-list
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
│  ├─ loops-btn
│  └─ settings-btn
├─ chat-viewport
│  ├─ chat-header
│  │  ├─ left-collapse-button
│  │  ├─ session-name
│  │  └─ header-controls-group
│  │     ├─ session-mode-indicator
│  │     ├─ activity-indicator
│  │     ├─ presence-mode-switch
│  │     ├─ autonomy-mode-switch
│  │     ├─ tab-icons
│  │     │  ├─ chat-tab-icon
│  │     │  └─ trajectory-icon
│  │     └─ right-collapse-button
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
│  │  ├─ ref-chips
│  │  ├─ input-textarea
│  │  └─ composer-footer
│  │     ├─ think-switch?
│  │     ├─ search-switch
│  │     ├─ permission-selector
│  │     ├─ model-effort-selector
│  │     │   ├─ model-selector
│  │     │   └─ effort-selector?
│  │     ├─ ref-btn
│  │     └─ send-or-stop-btn
│  └─ chat-footer
│     ├─ session-statistics
│     ├─ token-usage
│     └─ context-used
└─ context-panel
   ├─ artifact-preview
   │  ├─ artifact-preview-head
   │  │  ├─ artifact-preview-title
   │  │  └─ artifact-preview-open
   │  └─ artifact-preview-body
   └─ context-detail
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
│  │  │     ├─ remote-model-item*
│  │  │     │ ├─ remote-model-id
│  │  │     │ ├─ fee-select
│  │  │     │ └─ remote-add-btn
│  │  │     └─ remote-model-response
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

loops-modal
├─ loops-sidebar
│  └─ loops-summary
│     └─ current-engine-label
├─ loops-viewport
│  ├─ loop-topology
│  ├─ loop-nodes-table
│  │  └─ loop-node-row*
│  │     ├─ loop-node-id-label
│  │     ├─ loop-node-type-label
│  │     ├─ loop-next-label
│  │     └─ loop-hooks-editor
│  │        └─ hook-slot*
│  │           ├─ hook-target-select
│  │           ├─ hook-remove-btn
│  │           └─ hook-add-btn
│  └─ config-footer
│     ├─ reset-btn
│     └─ save-btn
└─ loops-panel
   ├─ reset-defaults-btn
   └─ close-loops-btn

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
loops-btn -> loops-modal

### 3.2 models-modal

add-provider-btn -> provider-add-tab（打开新增供应者标签页）
add-model-btn(provider_id) -> model-add-tab（打开新增模型标签页，携带 provider_id）
model-edit-btn(model.id) -> model-edit-tab（打开模型编辑标签页）
save-btn(providers) -> AgentClient.call("providers", {op:"upsert", payload:<整体 providers 数组>}) -> 整体写回 user/providers.json
fetch-models-btn -> AgentClient.call("fetchModels", {baseurl, apikey}) -> remote-models-section（渲染 remote-model-item*，并写入 remote-model-response 原始响应）
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

### 3.5 loops-modal

loops-btn -> loops-modal（打开时 loops.list 拉取 engines / nodes / builtins / hooks 覆写）
save-btn(hooks) -> AgentClient.call("loops", {op:"upsert", payload:{hooks}}) -> 整体写回 user/loops.json（数组顺序即执行顺序，校验 slot / on / target 且禁止重复三元组）
reset-btn -> 放弃未保存编辑，重新 loops.list 拉取
reset-defaults-btn -> AgentClient.call("loops", {op:"upsert", payload:{hooks:<仓库默认两条 translate hook: builtin.translate-input / builtin.translate-output>}}) -> 恢复出厂（需 uiConfirm）
close-loops-btn -> 关闭

---

## 4. 布局关系

shell
   children: thread-sidebar | chat-viewport | context-panel
   arrange: horizontal

thread-sidebar
   children: sidebar-header, new-session-button, workspace-bar, workspace-session-tree-list, deleted-sessions-list, models-btn, permissions-btn, loops-btn, settings-btn
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
   contains: left-collapse-button, session-name, header-controls-group (session-mode-indicator, activity-indicator, presence-mode-switch, autonomy-mode-switch, tab-icons, right-collapse-button)
   tab-icons: chat-tab-icon, trajectory-icon
   note: 两段式，左组贴左（left-collapse-button + session-name，普通布局包裹、无 data-name）、右组 header-controls-group margin-left:auto 靠右，中间为弹性空白；session-name 尽量展开不省略；空间不足时右组切紧凑（收间距 + 文案缩写，见 app.js 的 ResizeObserver）

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
   children: ref-chips (above input-textarea), input-textarea, composer-footer
   composer-footer: think-switch, search-switch, permission-selector, model-effort-selector(model-selector + effort-selector), ref-btn, send-or-stop-btn
   note: presence-mode-switch / autonomy-mode-switch 已移至 chat-header（见上）；权限预设与模型/推理等级在 composer-footer 提供 DSH 风格快捷选择，侧栏 permissions-btn / models-btn modal 仍作深度配置

chat-footer
   shows: session-statistics, token-usage, context-used
   note: 活动/权限/自主度由各自控件(activity-indicator / permissions-btn / autonomy-switch)承载，不在状态栏重复
   format:
     session-statistics: "⟳ N turns M steps · K tok/s"
     token-usage:        "▤ X.XM tok · Cache hit NN%"
     context-used:       "[SVG donut] NN%"

context-panel
   position: right
   default: hidden
   shows:
     artifact-preview: 写文件类工具「预览」按钮触发，按扩展名渲染产物（md/html/图片/代码）
     context-detail: 点击普通 tool-call 触发，展示参数/结果/引用来源

collapse
   left-collapse-button  → thread-sidebar
   right-collapse-button → context-panel

attachment
   no AttachmentDropzone node; 文件引用由 ref-btn 的「引用本地文件」承接

loops-modal
   three-part: loops-sidebar | loops-viewport | loops-panel
   loops-viewport: loop-topology (left, read-only) + loop-nodes-table (right, editable)
   note: current-engine-label 只读（展示 AGENT_LOOP_ENGINE，重启生效，不提供引擎切换）；loop-next-label 只读（next 链不可编辑）；id/type/entry 只读，仅 loop-hooks-editor 可编辑 hooks；loop-topology 含静态 next 链 + decide-next→auto-compact 回环 + 实时 hooks 虚线

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