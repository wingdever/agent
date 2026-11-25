# 与 DSH 的能力对照

## 1 当前实现

本项目是一个单进程、单用户、Electron + Web 双界面的 micro harness：16 个 core 子域、62 个带 registry 的工具、29 张表、事件溯源存储、node-graph 主循环、可用的 subagent 与 workflow。

DSH 是 Cordis 插件组合的 monorepo：55 个能力组、406 个包，同一套契约下提供 5 个出厂 profile 与桌面端。

对照按「语义」而不是「文件数」判定，状态分五档：

| 状态 | 含义 |
|---|---|
| 对齐 | 关键语义与失败路径都成立 |
| 部分 | 主路径成立，缺一侧能力或边界 |
| 雏形 | 有数据/接口，行为不完整 |
| 缺失 | 没有对应实现 |
| 不做 | 明确决定不追 |

### 1.1 总表

| # | 能力域 | DSH 对应 | 我们现状 | 状态 | 优先级 |
|---|---|---|---|---|---|
| 1 | 主循环 / 轮次 | `core/agent`、`core/agent-loop` | `node-graph` 节点链、队列、busy 闸门、bare 模式 | 对齐 | — |
| 2 | 工具与注册表 | `core/tools` | 62 个目录式工具、JSON Schema、`requires` 能力标签、权限门 | 对齐 | — |
| 3 | 上下文压缩 | `compaction/*` | `compaction` + `compaction-runner` + `tool_result_prunes` | 部分 | P1 |
| 4 | 子代理 | `subagent/*` | spawn/fork、树、命名、消息、打断、结算、`delivery=caller` | 部分 | P1 |
| 5 | 脚本编排 | `workflow/*` | `core/workflow` + `lib/workflow-runtime`，worker-vm、caps、meta 校验 | 对齐 | — |
| 6 | Agent Team | `team/*` | `team_tasks` 表 + `TeamService` + 四个 `team_task_*`：快照、revision CAS、blockedBy DAG、owner/Lead 授权、writeScopes 告警；Team 模式隐式开启，无 UI 投影 | 部分 | P1 |
| 7 | 后台作业 | `jobs/*` | `jobs` 表 + `JobService`：start/output/wait/kill、输出环、完成通知、按 owner 恢复；workflow 后台已接通 | 对齐 | — |
| 8 | 定时任务 | `schedule/*` | `schedules` 表 + `ScheduleService` + 四个 `schedule_*`：七种 timing、单 timer、到点投递、latest occurrence 合并、三种 target；无 UI 页 | 部分 | P2 |
| 9 | 插件 / 组合 | `boot/plugin-*`、`bundle/*` | 只有内置注册表（tools/UIs/transports/channels/proxies），无外部插件加载 | 缺失 | P0 |
| 10 | 技能 | `skill/*` | 文件系统 provider + rank 合并 + `skill` 工具 | 部分 | P1 |
| 11 | 会话服务 | `session/*`、`session-query` | 事件溯源 25 表、fork、轨迹 RPC、会话列表搜索 | 部分 | P1 |
| 12 | 存储接缝 | `storage/*` | 仅 pgmicro 单实现，无迁移 | 部分 | P2 |
| 13 | 权限 / 沙箱 | `sandbox/*`、`permissions` | 三级工具权限 + fs 路径策略；无进程隔离 | 部分 | 不做 |
| 14 | 循环守卫 | `guard/*` | 各工具自带 timeout；无重复调用提醒、无统一超时策略 | 缺失 | P1 |
| 15 | MCP | `mcp/*` | stdio / streamable-http 客户端、动态 `mcp__*` 工具、三个资源工具、重连与 `tools/list_changed` | 部分 | P2 |
| 16 | LSP | `lsp/*` | `core/lsp` 单工具四操作；stdio provider 由 `user/lsp.json` 配置，懒启动、文档同步、空闲回收 | 部分 | P2 |
| 17 | Shell / 终端 | `shell/*`、`terminal/*`、`subprocess` | 一次性 / 持久 `bash`、PTY 终端六件套、侧栏 xterm + WebSocket、用户接管、`user_terminal_*`；目标环境仅 Linux，Windows `pwsh` 不做；第一版不做跨重启恢复 | 对齐 | — |
| 18 | SSH / 远程执行 | `ssh/*` | 无 | 缺失 | P2 |
| 19 | 附件 / 多模态 | `attachment/*` | 有文件引用与 IM 媒体出站；无持久图片附件进模型 | 雏形 | P1 |
| 20 | 凭据 | `credentials/*` | provider key 明文 JSON、Lark OAuth token store | 部分 | P1 |
| 21 | 模型接入 | `llm/*` | 3 个 provider 适配器、流式、reasoning effort、token meter | 部分 | P1 |
| 22 | 连接器 | `connector/*` | Lark proxy + Feishu/Yunhu/QQ channel | 部分 | P2 |
| 23 | UI / Host / API | `host/*`、`api/*`、`client/*` | Web + Electron、`POST /api/call` | 部分 | P2 |
| 24 | SDK / ACP | `sdk/*`、`acp/*` | ACP 入站适配器可用；无对外 SDK | 部分 | P2 |
| 25 | 浏览器 / 桌面操作 | `browser-use`、`computer-use` | Playwright `browser_*` 七工具；无桌面操作 | 部分 | P2 |
| 26 | 产物 / 文档 | `deliverables/*`、`document/*` | `present` 交付、右栏预览、Lark 文档代理；无工作区变更记录、无 Office 渲染 | 部分 | P2 |
| 27 | 遥测 / 反馈 / 账号 | `telemetry`、`feedback`、`account` | 无 | 缺失 | 不做 |
| 28 | 预设 / 角色 | `preset/*` | 只有 activity/autonomy/activity 三轴，无声明式 preset 与 revision | 雏形 | P2 |
| 29 | 验证 / 治理 | 88 个 `verify-*`、Agent Notes | `node --test` 478 项、`scan.js` 12 条架构规则、distributed-dev 规范 | 部分 | P1 |

### 1.2 已对齐的部分（不必再补）

- 主循环的节点链、`resolve-target → assemble → pre-step → model-call → tool-execute → decide-next` 成环、忙碌入队、`bare` 模式。
- 工具目录式注册与 schema 校验、`requires` 能力标签、三级权限、fs 写路径白名单。
- workflow 的 `meta/script/args`、`agent/parallel/pipeline/phase/log`、并发与总量上限、meta 迁移校验、返回 JSON。
- subagent 的 spawn/fork 上下文语义、父子会话隔离、`send_message`、`list_agents`、`interrupt_agent`、结算通知、`caller` 交付。
- 事件溯源存储、压缩边界、轨迹读取、会话回收站与重命名。

## 2 与原型的关系

按「缺什么」分成三类，每类只列会改变能力边界的条目。

### 2.1 完全缺失（原型有、我们没有）

| 能力 | DSH 的位置 | 缺了会怎样 |
|---|---|---|
| 插件加载与组合 | `packages/boot/plugin-manager`、`plugin-loader`、`bundle/*` | 所有扩展（MCP、LSP、schedule、connector）都只能写进 core，无法安装/卸载/替换 |
| 循环守卫 | `packages/guard/*` | 模型重复同一调用时无人提醒；工具超时靠各工具自己实现 |
| 对外 SDK | `packages/sdk/*` | 外部程序不能以 SDK 方式驱动本 harness；ACP 入站已完成 |
| 桌面操作 | `packages/computer-use` | 不能操作本机桌面、窗口和原生应用 |
| 凭据库 | `packages/credentials/*` | 密钥只能明文躺在 `user/*.json`，没有按名引用、轮换、OS 权限 |
| 遥测 / 账号 | `packages/telemetry`、`account` | 没有产品分析、没有 DeepSeek 账号授权 |
| SSH / 远程执行 | `packages/ssh/*` | 只能操作本机，不能远程执行 |

### 2.2 有基础但语义不足

| 能力 | 我们已有的 | 与 DSH 的差 |
|---|---|---|
| 后台作业 | `jobs` 表 + `JobService`：输出环、wait/kill、完成通知、按 `owner_pid` 重启恢复 | 只有进程内 run；没有跨进程 worker、没有多主机分发、没有作业级重试策略 |
| 定时任务 | `schedules` 表 + `ScheduleService`：七种 timing、单 timer、到点投递、latest occurrence 合并、三种 target | RRULE 是受控子集；无 UI 自动化页；Host 停机不投递；非 exactly-once；共用 `data/store.db` 的多个 Host 没有租约 |
| 会话 | 25 表、fork、压缩、轨迹 | 缺自动标题、全文检索/导出、跨会话快照、投影缓存、会话级 telemetry；`sessions.name` 是手填 |
| 技能 | 文件系统 provider、rank 合并 | 缺分层 scope、上游技能下载 provider、技能目录的会话级裁剪 |
| 子代理 | spawn/fork/消息/打断/`wait_agent` | 只有 in-process 后端，缺 codex/claude-code/acp 等 out-of-process 后端与冷恢复 |
| 附件 | 文件引用、Lark 媒体 | 没有“把图片存下来、下一轮再送给模型”的持久附件模型 |
| 模型接入 | 3 个 provider、流式、effort | 没有模型目录、路由选择、按请求覆盖、缓存计量等 DSH llm 组的能力 |
| 存储 | pgmicro 单实现 | 没有 jsonl/sqlite 可替换实现，也没有迁移链 |
| 产物 | `present` 交付、右栏预览 | 没有每轮工作区变更记录（diff/行数） |
| 文档 | Lark 文档代理 | 没有本地 Office 渲染/转换（LibreOffice kit） |
| MCP 进阶 | 工具调用、资源读取、重连 | 没有 `resources/subscribe`、prompt 模板、sampling / elicitation / roots、tasks extension |

### 2.3 明确不做

- **进程级沙箱**：DSH 用 `read-only / workspace-write / danger-full-access` 三档约束子进程；本项目 roadmap 已明确不做。现状是 `bash` 直接继承用户权限，靠 fs 策略与工具权限兜。若未来开放远程执行，再重新评估。
- **多用户账号体系**：本项目是个人单用户；`account`、`identity`、多租户隔离不追。
- **Cordis 全量组合机制**：55 组 406 包的 profile/bundle/patch 体系不适合这个规模；只借“清单 + 生命周期 + 可替换”三点，不引入三层 YAML。
- **Windows PowerShell（`pwsh` / 持久 `pwsh`）**：目标环境只有 Linux，不做 Windows 方言、ConPTY 和对应工具；`bash` / PTY 终端是唯一 shell 面。

## 3 后续计划

按“投入产出比 + 对现有能力的解锁程度”排序。

### P0：先补三个“地基”

1. **后台作业注册表（已完成）**
   - 落地：`core/jobs/` + `jobs` 表 + `job_wait`；`workflow run_in_background` 已可用。
   - 语义：id/kind/status、输出环、`wait`、`kill`、完成通知、重启恢复；细节见 `docs/runtime/jobs.md`。
   - 剩余：跨进程 worker / 多主机分发 / 作业级重试，暂不在本期。

2. **Agent Team 任务板（已完成）**
   - 落地：`core/team/` + `team_tasks` 表 + 四个 `team_task_*`；复用 `subagents` 树做成员。
   - 语义：任务快照、`revision` CAS、`blockedBy` DAG、owner 认领、仅 Lead 改派、`writeScopes` 只告警；细节见 `docs/runtime/team.md`。
   - 剩余：root 级 Team 模式开关、浏览器投影、跨进程看板。

3. **插件清单与生命周期**
   - 目标：外部目录 `plugins/<name>/plugin.json` 可注册工具/提示段/技能/通道；有 `install/uninstall/list`，卸载时回卷注册；不做热重载与三层 patch。
   - 落点：`core/plugins/` + `scripts/plugin-check.js`；先只支持“后端插件”，UI 插件二期。
   - 验收：装一个只提供只读工具的示例插件，`/plugins` 可见，卸载后工具消失且无残留监听。

### P1：可用性与生态

4. **会话标题 + 检索**：`titleFromPrompt` 兜底 + 首轮后异步小模型标题（失败保留兜底）；`session.search` 全文检索与导出。
5. **Guard**：重复工具调用提醒 + 统一工具超时策略；两个都可独立包，不碰主循环。
6. **MCP 进阶能力**：`resources/subscribe`、prompt 模板、sampling / elicitation / roots、tasks extension；客户端、动态工具和资源读取已完成。
7. **附件**：图片落盘 + 消息引用 + 下一轮回送；先只做图片，不做任意文件。
8. **凭据**：`user/credentials.json` 改成「名字 → 值」引用，provider/channel 配置只写名字；启动时解析，权限 0600。
9. **子代理 out-of-process 后端**：`wait_agent` 已完成；codex/claude-code/acp 后端与冷恢复二期。

### P2：场景扩展

10. **定时任务（已完成核心）**：`schedules` + `ScheduleService` + 四个工具；剩余 UI 自动化页、完整 RFC 5545、跨 Host 单投递租约。细节见 `docs/runtime/schedule.md`。
11. LSP（已完成：stdio 语言服务器 + 单工具四操作；首版只接受 UTF-16 位置编码）。
12. SSH / 远程执行；本地持久终端与 PTY 六件套已完成。
13. 工作区变更记录（每轮 diff/行数，右栏产物面板已有基础）；`present` 已完成。
14. 对外 SDK（ACP 入站已完成；若要接出到其他 harness，再评估 SDK）。
15. 浏览器/桌面操作（浏览器已完成核心；桌面操作按需，优先级最低）。

### 建议的下一批提交

- `feat(team): shared task board with CAS and DAG`
- `feat(plugins): manifest loader with reversible registration`
- `feat(session): fallback title and full-text search`
- `feat(guard): repeat-call reminder and tool timeout policy`

后台作业、Agent Team 与定时任务已落地；三者只新增表与新增工具目录，不改原有表语义。原有 26 张表加新增 3 张，当前共 29 表。
