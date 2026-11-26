# maturity gap

## 范围

本文件回答「项目距离成熟、易用还差什么」，是一份横切评估，不替代 [`capability-gap.md`](capability-gap.md) 的 DSH 逐项对照：

- `capability-gap.md` 回答「与 DSH 差什么」；
- 本文件回答「离日常个人使用、离公开服务还差什么」。

判断以当前代码与实测为准，不以 `roadmap` 或 `feature_list` 的旧状态为准。代码变化后同步维护；本文件只写当前形态，不写变更史。

三个视角：

- **个人开发 harness**：能支撑真实开发、架构可讲清楚、测试可信；
- **日常个人助手**：能每天用、重启不丢任务、安装门槛低、手机可达；
- **公开服务**：能被别人访问而不泄漏数据、不被滥用、可运维。

## 1 基线

当前实测：

- `node --test "test/**/*.test.js"`：520 项，517 pass / 3 skipped / 0 fail；
- `node scripts/graph/scan.js`：`nodes=289 edges=409`，12 条架构规则无违规；
- `tools/` 目录式注册，60+ 工具目录，覆盖文件、shell、浏览器、MCP、workflow、subagent、team、schedule、jobs、goal；
- 事件溯源会话存储、`node-graph` 主循环、subagent spawn/fork、workflow、jobs、schedule、team、goal 续轮、ACP 入站、A2A 入站均已落地；
- 云端能力仍停留在设计：无 `host.js`、无 Dockerfile/compose、无鉴权、无移动 presenter。

粗略成熟度：

| 视角 | 判断 | 理由 |
|---|---|---|
| 个人开发 harness | 7.5/10 | 主循环、工具、存储、测试扎实；插件与评测未闭环 |
| 日常个人助手 | 4.5/10 | 重启丢任务、安装门槛高、手机端不可用 |
| 公开服务 | 2/10 | 单用户模型，无鉴权/TLS/隔离/配额/审计 |

实际位置在 **M1 收尾到 M2 开头**：M1 的 `goal-auto-continue` 已实现，`session-save` 未闭环；M2 的技能有基础，跨会话记忆还没有；M3 的插件系统、MCP 深化、out-of-process subagent 未完成；M7.5 只有设计，没有实现。

## 2 P0：最挡路的五件事

### 2.1 会话与在途任务不能恢复

**当前**

- 会话历史能通过 `session.trajectory` 回看；
- 在途轮次、待审批、待回答、plan review 只存在内存：`core/interactions/index.js` 的 `pendingApprovals` / `pendingQuestions` / `pendingPlanReviews` 都是 `Map`；
- 进程重启后，历史还在，但正在跑的 turn、等人回答的卡片、plan review 全部消失；
- 后台作业重启后只会标 failed；goal 在 session-start 时主动 disarm，不会自动续跑。

**缺什么**

`session-save`：事件溯源已经存了全量数据，缺的是恢复投影与在途交互接续。不是“把消息读出来”，而是把「会话处于什么状态、下一轮该做什么」恢复出来。设计见 [`../../../runtime/session-recovery.md`](../../../runtime/session-recovery.md)。

**验收**

- 在一个 turn 执行中 kill 进程，重启后该 turn 显示为 `interrupted` 或可继续，不能静默消失；
- 待审批 / 待回答 / plan review 在重启后重新出现在 UI 与 `/api/interactions/pending`；
- goal 保持 disarm，等人显式 resume，不能自行续跑；
- jobs / schedule 的重启状态与输出尾一致，不出现“看起来还在跑、实际已死”。

### 2.2 交付形态只有源码启动

**当前**

- `package.json` 只有 `start / test / graph / providers / channel / acp / a2a`；
- 没有 build、安装包、签名、自动更新、版本发布；
- 启动要求 Node、pnpm、`python3`、`make`、`g++`、`node-pty`；
- 没有首次启动引导，配置仍以 `user/*.json` 为主。

**缺什么**

面向非开发者的交付形态：安装包或单文件分发、首启向导、版本化更新、失败回滚、日志位置可见。

**验收**

- 一台干净机器不装 Node 工具链，能完成安装、配置 provider、打开会话、发一轮消息；
- 升级失败能回到上一版本；
- `user/`、`data/`、`log/` 的位置在首启时可查看，不需要读源码。

### 2.3 公网入口没有护栏

**当前**

- `launcher.js` 顶层 `import electron`，依赖 `app.whenReady()`，云主机无桌面不能直接跑；
- HTTP transport 只 bind `127.0.0.1:18765`；
- 只有 `POST /api/call` 与 `/terminal` WebSocket，没有静态页面、`/healthz`、登录、鉴权；
- CORS 反射任意 `Origin`；
- `/terminal` 是完整 shell；
- 没有 Dockerfile / compose / Caddyfile。

**缺什么**

[`cloud-deployment.md`](../../../ops/cloud-deployment.md) 的 F1–F5 与 G1–G5 都还没有进入代码。公网发布必须先有：无头 host、同源静态服务、单用户 token + 签名 cookie、TLS、限流、Origin 校验、能力收窄（终端/渠道默认关、权限默认 ask、文件范围限工作区）、密钥外置。

**验收**

- 公网只开 443，18765 不对外；
- 未登录访问 `/api/call`、`/api/interactions/pending`、`/terminal` 全部 401 / 拒绝 upgrade；
- 登录失败有限流；token 不进 URL、不进 localStorage、不写日志；
- `/healthz` 只返回 `ok` / `degraded`，不泄漏路径、版本、配置、堆栈。

### 2.4 「公开给大家用」与单用户模型冲突

**当前**

- 单进程、单用户、单 `data/store.db`、单 `user/`、单工作区；
- 所有访问者共享会话、API key、权限、文件；
- 单用户 token 只能挡陌生人，不能做隔离。

**两种产品路线**

1. **每人一个实例 / 容器**：继续复用当前单用户 core，每个用户独立的 `data/`、`user/`、`work/` 与端口；先邀请制、单机多容器。成本最低，和现有代码最契合。
2. **多租户**：账号、身份、按用户 scoped 存储、配额、审计、跨用户隔离。这是 M9 的工程，不是给现有 `store.db` 加一个 `user_id` 就能完成。

**口径纠正**

多用户账号体系不是“永久不做”，而是 **暂不做、M9 必做**。当前单用户形态是现阶段的产品边界，不是最终定位。公开服务前必须先拍板走“每人一实例”还是“多租户”；不拍板就无法谈配额、隔离、审计和滥用防护。

**验收**

- 用户 A 看不到用户 B 的会话、文件、密钥、运行状态；
- 每个用户有独立的 provider 凭据与工作区；
- 单用户异常不影响其他用户；资源有上限。

### 2.5 手机端是空白

**当前**

- `ui/web` 是固定三栏（240px 会话栏 + 300px 上下文栏），CSS 只有 900px 的局部断点；
- 没有 PWA manifest / service worker；
- SSE 没有 event id、没有 `Last-Event-ID`、没有断线续传；
- 没有 `/api/interactions/pending`，手机重连后无法重新渲染待审批 / 待回答；
- 飞书 projector 只处理 `token / done / error`，审批、提问、plan review 不投影成卡片。

**缺什么**

移动 presenter + 连接可靠性 + 交互投影。不是“把桌面页面缩小”，而是窄屏下只保留会话、聊天、审批、goal 状态，其余管理面收进抽屉；断线不取消 turn，重连能补事件与待交互。

**验收**

- 390px 宽度下能完成聊天、审批、提问回答；
- 锁屏 2 分钟后回来，流能续上或至少拿到最终结果与待交互；
- IM 渠道里审批 / 提问 / plan review 是可操作卡片，不是沉默。

原生 App 不是当前最短路径：先把移动 Web/PWA 的 presenter、SSE 续传、交互投影做出来，原生 App 才有稳定的协议可复用；否则只是把同样的缺口搬到 App 里，还多出推送、发版、证书三件事。

## 3 P1：能用，但不顺手

### 3.1 可靠性

- **Guard / 预算**：主循环没有硬性 step / token / 费用上限，没有重复工具调用提醒，只有各工具自带 `timeoutMs`；长任务容易空转烧钱。
- **模型单点**：3 个 provider、单 target；请求失败直接 `TurnError`，只有上下文溢出重试，没有跨 provider 降级与重试策略。
- **作业与定时任务耐久性**：jobs 只有进程内 run，重启后标 failed；schedule 在 Host 停机时不投递，多 Host 共用 `data/store.db` 没有租约。
- **跨会话记忆缺失**：`core/memory` 是轮次 / 步骤状态，不是长期记忆；没有 memory 工具与 store，新会话基本从零开始。
- **子代理只有 in-process**：进程崩了子代理全没，缺 out-of-process 后端与冷恢复。

### 3.2 易用

- **会话管理弱**：会话名手填，无自动标题；只有按名称过滤，无全文检索 / 导出。
- **管理面缺页**：team、schedule、goal、jobs 有后端，但导航没有任务板、定时任务页、goal 面板，只能靠工具 / 命令。
- **附件链路不完整**：`read_image` 能把图片落盘，但用户消息里的图片附件还没有“粘贴 → 引用 → 下一轮继续送模型”的完整链路。
- **首启与配置**：模型、工具、技能、权限页已有，但没有一键健康检查与引导；配置错误往往到第一轮对话才暴露。

### 3.3 扩展

- **插件系统缺失**：没有 `plugins/`，所有扩展仍要写进 `core`；装、卸、回卷注册都没有。它在 DSH 对照里是 P0，在产品成熟度排序中排在扩展批次。
- **MCP 进阶**：只到工具 / 资源 / 重连，缺 `resources/subscribe`、prompt 模板、sampling / elicitation / roots、tasks extension。
- **对外能力**：无对外 SDK；SSH / 远程执行缺失；桌面操作缺失；工作区 diff / 行数记录缺失；本地 Office 渲染缺失。

### 3.4 评测与治理

- **没有 eval**：520 个单测只证明“不回归”，不证明 agent 好用；没有 eval 集、没有 eval-driven 开发。
- **没有端到端测试**：没有 UI / Electron / 浏览器 e2e，移动 presenter 与云端入口无法做发布前 smoke。
- **没有生产遥测**：无崩溃报告、无关键路径指标、无会话级 telemetry；出问题只能看日志。
- **文档状态漂移**：`feature_list.json` 仍写 6 个 pending，但 skill / subagent / goal 已有代码与测试；`feature_list` 写 20 个工具目录，实际 60+。roadmap 的“进度”目前不可信，需要生成或校验，而不是手填。
- **数据运维**：没有会话 / 数据备份与导出；当前“开发项目可删库”的约定不适合公开服务。

## 4 边界

### 明确不做

- 进程级沙箱：靠权限门与 fs 策略兜，不实现 sandbox 分支；
- Cordis 全量组合机制：只借“清单 + 生命周期 + 可替换”，不引入三层 YAML；
- Windows PowerShell：目标环境只有 Linux，`bash` / PTY 是唯一 shell 面。

### 暂不做但未来必做

- 多用户账号 / 身份 / 多租户隔离：M9；当前单用户是阶段性边界，不是永久不做；
- 公开服务所需配额、审计、滥用防护：随 M9 与云部署护栏一起补。

## 5 排序

### 个人日常使用

1. `session-save`（含 pending interactions 持久化）——先让任务可托付；
2. 安装包 / 自动更新 / 首启引导——先让非开发者能装；
3. Guard / 预算 + 凭据外置——先让长任务不烧钱、不裸奔；
4. 移动 presenter + SSE 续传 + 交互投影——先让手机可用；
5. 插件 / MCP 进阶 / eval——扩展与质量。

### 公开服务

1. `session-save`；
2. 无头 host + 鉴权 / TLS / 限流 + 能力收窄；
3. 拍板“每人一实例”还是“多租户”；
4. 移动 presenter + SSE 续传 + `/api/interactions/pending` + 渠道交互投影；
5. 配额 / 备份 / 审计 / kill switch；
6. 插件 / eval / 遥测。

## 6 验收门槛

- **重启**：turn 执行中 kill 进程，重启后不静默丢任务；待审批 / 待回答能继续。
- **安装**：干净机器不装 Node 工具链，能完成安装、配置、首轮对话。
- **公网**：外部扫描只有 443；未登录 API / WS 全部拒绝；终端与渠道默认关。
- **手机**：390px 能聊天与审批；锁屏重连不丢结果；IM 卡片能操作。
- **扩展**：装一个只读工具插件，`/plugins` 可见；卸载后工具消失且无残留监听。
- **评测**：至少一组固定 eval 任务 + 一条 Web e2e smoke，能作为发布门。
