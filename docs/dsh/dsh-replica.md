# 从 DSH 学习优化 UI（讨论结论）

> 本文档记录一场关于"从 DeepSeek Harness (dsh) 学习，完善与优化本 agent UI"的讨论结论。
> 讨论采用 grill（逐轮拷问）方式，把每个隐含假设逼成显式决策。本文是讨论的沉淀，不是实现清单。

## 1. 讨论范围与边界

- **学什么**：学 DSH 的**交互范式与信息架构**（会话组织、轨迹可视化、模式/设置的可发现性），**不追视觉精致度**（本 agent 是开发用 harness，非线上产品）。
- **不写码**：本文档阶段仅讨论与沉淀，不修改任何代码或现有文档。
- **DSH 认知来源**：`dsh` skill 文档 + 公开网络资料（CSDN / dshpluginhub）+ 本机 dsh 0.2.1-rc.2 的运行时事实。DSH 前端为打包 SPA，未逆向其源码；视觉细节以文档描述为上限推断，不臆测。

## 2. DSH UI 事实基线

来自公开资料与 `dsh` skill 文档的归纳：

- **左栏**：工作区文件树 + 会话列表（自动保存，支持搜索 / 重命名 / 删除 / 回溯恢复）+ 工作区切换 + 新建会话；**新建会话时选择预设模式**（4 套，运行后不可中途切换）。
- **中栏（对话区）**：输入框支持 `@` 引用本地文件与历史会话、粘贴图片；多模态（图文混合，经 `/goal` `/plan`）；**模型选择器 + 推理等级**；底部状态栏展示当前模型 / 上下文 Token 占用 / **TPS / 缓存命中率** / 工作区权限等级。
- **右栏**：**产物预览**（HTML、文档、图表）。
- **轨迹面板（Trajectory）**：完整记录模型思考、工具调用（参数 + 返回）、文件修改、终端命令，**逐条可回溯 / 回放**——DSH 最强项，调试黑匣子。
- **三档权限模型**：只读 / 工作区写 / 全访问（危险档二次确认），敏感操作弹审批窗。
- **架构**：host（服务）与 client（界面）分离，UI 是可替换模块（ui-conversation / ui-primitives / ui-sidebar / ui-workspace）走 ACP 协议；"一切皆插件"。

## 3. 对照本 agent 当前 UI

当前 UI 结构（已读 `ui/web/index.html` / `app.js` / `settings.js`）：

| 维度 | 本 agent | DSH | 差距 |
|---|---|---|---|
| 会话列表 | 有树，但无搜索 / 重命名 / 删除 / 恢复 | 全套 CRUD + 回溯 | 大 |
| 轨迹 | `trajectory-tab` 空状态未实现 | 强轨迹面板 | 最大 |
| 上下文引用 | 无 `@` | `@` 文件 / 会话 | 中 |
| 模型 / 推理档 | 侧栏 models 按钮，composer 无推理档 | composer 内模型 + 推理等级 | 中 |
| 状态栏 | 有 model / token，缺 TPS / 缓存 / 权限 | Token / TPS / 缓存命中 / 权限 | 中 |
| 右栏 | 仅 tool-call 详情 | 产物预览 + 详情 | 中 |
| 权限 | 已有 permissions 按钮 + 审批门 | 三档 + 审批弹窗 | 小（已有基础） |
| 模式 | 活动 8 选 1 可随时切 | 预设 4 选 1，建会话时定、不可中途切 | 理念不同 |

## 4. 可借鉴特性清单（按开发 harness 价值排序）

| # | 特性 | 优先级 | 说明 |
|---|---|---|---|
| 1 | **轨迹面板落地** | ★ 高 | 把 `trajectory-tab` 从空状态做成"思考 / 工具调用 / 文件改动 / 终端命令"时间线，逐条可展开回溯。已有 tool-call 卡片数据，缺可视化与时间线聚合。最大差距、最契合 dev 可观测性。 |
| 2 | **会话列表增强** | ★ 高 | 搜索 + 重命名 + 删除 + 回溯恢复（DSH 的会话 CRUD）。 |
| 3 | 上下文 `@` 引用 | ○ 中 | 输入框 `@` 文件 / 会话，把引用作为上下文注入。 |
| 4 | 状态栏补齐 | ✅ 已完成 | TPS / 缓存命中率 / 权限等级（core 新增 `usage` 上报 + UI 聚合到 `chat-footer`）。 |
| 5 | 右栏产物预览 | ○ 中 | HTML / 文档 / 图表渲染（替代仅 tool-call 详情）。 |
| 6 | 推理等级控件 | △ 低 | composer 内加 reasoning effort（模型层是否支持待确认）。 |
| 7 | 多模态输入 | △ 低 | 图片粘贴 + 图文混合（dev harness 价值较低）。 |

**结论**：先做 1 + 2（高价值、契合 dev 场景、数据已部分具备）；3–5 为二期；6–7 低优先。

## 5. 轨迹面板的信息模型

- **复用现有事件流**（`agent-request` / `model-response` / `tool-call-card` / `plan-review`），不另起数据采集管道。
- 按时间线聚合为**步骤卡**：思考摘要 + 工具调用列表 + 文件 diff 入口 + 终端命令；逐条可展开回溯。

## 6. 模式哲学决策（关键：活动流转模型）

经讨论，活动（activity）采用**流转模型**而非"建会话锁定"：

- **自然流转**：一个活动**完成后**可进入其它活动（类比一般 agent 的 plan → implement：plan 经 `exit_plan_mode` 批准即完成，自然进入 build-code）。
- **强制切换**：活动**未完成**时也可强制切换，但需**二次确认**防误操作。
- **预设退化为初始活动**："建会话定预设"仅作为**新建会话时的初始活动默认值**，不再有锁定含义；会话内活动可切。

### 6.1 决策细则（Q9–Q18）

- **Q9 固化范围（修正）**：不再固化 activity。presence（自动推断）与 autonomy（可随时提权 / 降权、永久提权语义）保持运行时可变——避免破坏 autonomy 硬规则（out → autonomous 自动触发）。activity 建会话时选初始值，但可切。
- **Q10 预设内涵**：预设 = **仅活动模式**（8 选 1），不含模型 / 权限。模型已由侧栏 models 按钮管理，权限已有独立审批门；避免预设组合爆炸（8 × 模型 × 权限）。
- **Q11 现有活动选择器去向（修正）**：从 composer 移除 / 禁用 `activity-mode-selector`；改为**会话内"当前活动指示器 + 可点击切换"**（取代原 selector 或与之合并），显示当前活动与完成态；点击展开切换菜单（含强制切的二次确认）。新建会话流程里仍选初始活动。
- **Q12 中途切换逃生通道（被 Q16/Q17 取代）**：不再需要"复制会话重开"——已可通过强制切换（二次确认）原地切。复制会话仍可作为独立功能保留，但不再是切换的唯一通道。
- **Q13 与范围一致**：活动流转属信息架构 / 交互范式层，符合 Q1"学范式不追视觉"。

#### 流转细则

- **Q14 "活动完成"定义与判定**：由 **model 自判并上报完成事件**（如 plan 经 `exit_plan_mode` 批准=完成，build-code 经收尾=完成）；UI 收到完成信号后将该活动标记为"已完成态、可自然切换"。契合 `agent-mode.md` 的"activity 由 model 自判、无硬守门"。
- **Q15 流转受限**：**任意跳**，但 UI 给**推荐下游**提示（如 goal-plan 完成后高亮建议 build-code），不强制顺序。保留三轴正交灵活性 + 借 plan→implement 直觉引导。
- **Q16 强制切换二次确认**：**内联 modal**（非浏览器原生 confirm），文案说明"当前活动 <X> 尚未完成，切换将中断其进行中的工作；plan-mode 等策略即时失效"，提供"确认切换 / 取消"。契合已有审批弹窗风格。
- **Q17 与 autonomy 交互**：**autonomous 下不弹二次确认，直接切换**（autonomous 语义=代理自行决策、人不干预；二次确认本质也是"向人确认"，与 ask 自动 deny 一致）。二次确认仅 supervised 下出现。
- **Q18 活动指示器语义**：新建会话选初始活动；会话内为**当前活动指示器 + 可点击切换**，显示当前活动 + 完成态；点击展开含强制切二次确认的菜单。"预设"= 初始活动默认值，无锁定。

> 注：这与 `docs/agent-mode.md` 当前描述的"三轴正交、activity 随时切"需对齐——新模型在"随时切"基础上增加了"完成态"与"强制切二次确认"两层语义。实现时需同步修订 `agent-mode.md` 与 `ui.md` 的模式说明。

## 7. 动手前待办（实现阶段处理，非本文档范围）

1. ✅ **数据 / 状态层**：`sessions` 表已加 `activity` 列；`createSession`/`updateSession` 落库 activity；UI 新建会话传 `selectedInitialActivity`，`selectSession` 从会话读取。`data/store.db` 已按 AGENTS.md 规则删除重建。
2. ✅ **新建会话流**：`new-session-button` 在点名后弹出初始活动选择（`openActivityMenu(onPick)`），写入 `selectedInitialActivity`。
3. ✅ **活动指示器改造**：移除 composer 的 `activity-mode-selector`（`index.html` + `app.js` 读写 + `settings.js` 初始化）；改为会话头 `activity-indicator` 按钮 + 切换菜单 + 完成态 `✓`；强制切在 supervised 下 `uiConfirm` 二次确认、autonomous 直接切；建会话保留初始活动选择。
4. ✅ **轨迹面板**：`trajectory-tab` 已渲染——core 新增 `session.trajectory` RPC + `getTrajectory` 聚合 turns/steps/messages/calls；前端 `renderTrajectoryTree` 时间线，复用 `createToolCard`/`setToolResult`/`showToolDetail`，思考可展开、点击 tool-call 联动 context-panel。详见 `plan-trajectory.md`。
5. ✅ **会话 CRUD**：搜索（侧栏搜索按钮 → 按名称过滤）、重命名（已有，保留）、删除（改为**软删除**：`deleted_at` 标记，保留 turns 供恢复）、**回溯恢复**（回收站视图列出已删会话，可恢复 / 彻底删除）。store 新增 `session.restore` op；`listSessions` 默认排除软删；`deleteWorkspace` 走硬删级联。
6. ✅ **文档同步**：`docs/ui.md`、`docs/agent-mode.md` 的模式描述已对齐新流转模型。
7. ✅ **完成事件上报**：`goal-plan` 经 `exit_plan_mode` 批准时 UI 置 `currentActivityCompleted=true`（同步指示器 `✓`），其余活动完成判定后续可扩展。
8. ✅ **#3 @ 引用**：composer 的 `@` 按钮（或输入 `@`）打开引用菜单，可选**历史会话**或**本地文件**；选中后以 chip 展示、可移除。发送时 `references` 随 `chat` 调用传入 core；core 新增 `_resolveReferences` 将文件内容 / 会话摘录拼为上下文块，注入到真实问题之前的 user 消息（独立于翻译步骤，不影响中文→英文翻译）。bare-chat 与正常会话模式均支持。
9. ✅ **#4 状态栏补齐**：`core/_stream` 在流式 / 非流式两条路径解析模型 `usage`（`prompt_tokens`/`completion_tokens`/`total_tokens`/`cached_tokens`，兼容字段缺失与 `prompt_tokens_details` 嵌套），统一上报 `usage` 事件；前端 `onChatEvent` 消费 `usage` + `turn-end`（steps/tools/durationMs），按 DSH 风格聚合到 `chat-footer` 三段（各带中性图标，无 emoji）——`session-statistics`（`⟳ N turns M steps · K tok/s`，turns/steps 间空格、会话累计 + 最近一轮 TPS）、`token-usage`（`▤ X.XM tok · Cache hit NN%`）、`context-used`（**SVG donut**：track + 动态 fill 弧 `stroke-dasharray` 按占用百分比实时更新 + `NN%` 文本，占假设窗口 128k 的估算占比）。活动 / 权限档 / 自主度已由各自控件（activity-indicator / permissions-btn / autonomy-switch）承载，不在状态栏重复。无数据显示 `-`（Q4 决策）。`selectSession` 重置计数、`turn-end` 后刷新累计。

## 8. 后续

第一波改造（前置 A、前置 C、#1 轨迹面板、#2 会话列表增强、#3 @ 引用）与 #4 状态栏补齐已完成。下一步：
- **二期 #5**：右栏产物预览
- **低优先 #6–#7**：推理等级控件、多模态输入

详见 `PLAN.md`。
