# distributed-dev

## 1 范围

本文件只回答一件事：**这个仓库如何拆成可并行开发的子任务，以及并行之前必须冻结哪些契约。**

不记实现状态、不记排期；执行记录归各子任务的 patch 与 git log。适用于多 agent、多分支、多人同时对同一仓库动手的场景。

前提：入口与插槽已经是自注册结构（`tools/*/registry.json`、`core/loops/nodes/*/registry.json`、`channels|proxies/registry.js`），新增模块原则上不改中心代码；仍然会冲突的只有少数共享文件，本文件用「单一写入区 + 登记行 + 号段」把冲突压到可合并的量级。

## 2 结构前提与冲突热点

### 2.1 可以自注册的位置（并行安全区）

| 位置 | 注册方式 | 新增模块需要改动的中心文件 |
| --- | --- | --- |
| `tools/<name>/` | `registry.json` + `entry` 指向的 `run.js` | 无（`core/tools/registry.js` 目录扫描） |
| `core/loops/nodes/<id>/` | `registry.json`（`id/next/type/entry`） | 只有改链路时才碰别人的 `next` |
| `core/loops/builtins/<id>/` | 同上，`type:"builtin"`，不进默认链 | `agent/loops.json`（运行时覆盖，不是源码） |
| `channels/<type>/` | 导出一个符合 `channels/contract.js` 的对象，由 `channels/registry.js` 断言 | 无 |
| `proxies/<type>/` | 导出一个符合 `proxies/contract.js` 的对象 | 无 |
| `core/rpc/handlers/<domain>.js` | 命令描述符 + handler，由 `handlers/index.js` 汇总 | 一行登记 |
| `scripts/` | 独立脚本（`scripts-isolated` 规则：不得依赖 core） | 无 |

### 2.2 冲突热点（必须约定，不能靠自觉）

| 共享点 | 现状 | 冲突形态 | 约定 |
| --- | --- | --- | --- |
| `core/index.js` | 组合根，服务逐个 `new` | 每人加一行，位置互相踩 | 只在 `// --- registrations ---` 区块追加；由集成者合 |
| `core/storage/schema.js` | 25 张表的 DDL 数组 | 两人加表改同一数组 | 改为号段迁移文件，`schema.js` 只负责按号执行 |
| `proxies/lark/actions.js` | 22 个具名动作 + 1 个 `api` 逃生口，单对象 | 按业务域并行必冲突 | 先拆 `actions/<domain>.js` 片段，再由 `actions/index.js` 合并 |
| `channels/manager.js` | 生命周期 + pipeline + 去重装配 | 入站策略改动互相覆盖 | 策略下沉到独立模块，manager 只做编排 |
| `core/loops/loops-config.js` | 默认钩子两条写死 | 加钩子要改源码默认 | 默认只读；扩展走 `agent/loops.json` |
| `package.json` | 依赖与 npm scripts | 各任务各加各的 | 单一构建负责人 |
| `docs/path/feature_list.json` | 55 条人工维护 | 状态互相覆盖 | 任务只追加自己的条目；状态由集成者改 |
| `core/rpc/handlers/index.js` | 命令汇总 | 每人加一行 | 只在登记区块追加 |

## 3 契约

八份契约共同构成「并行也不跑偏」的最小约束。任何一份被违反，合并阶段一定出问题；违反契约的代码不进 main。

### C1 模块注册契约

适用于 tool、loop node、builtin node 三类目录化模块。

**tool `registry.json` 必填**

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `name` | string | `[a-z][a-z0-9_]*`，全仓唯一；与目录名一致 |
| `description` | string | 面向模型的能力描述，说明「做什么 + 什么时候用」 |
| `parameters` | JSON Schema | `type:"object"`，`required` 必须是 `properties` 的子集 |
| `type` | string | 现有值：`fs / builtin / web / bash / interaction / control / goal / todo / delegate / read / plan / lark / channels`；新增值需契约评审 |
| `entry` | string | 相对本目录，禁止 `../` 逃逸（`registry.js` 会检查） |

**tool 可选字段**：`prompt`（注入 system prompt 的使用说明）、`promptSection`、`defaultVisible`、`result`（`"json"` 时结果按 JSON 归一等）、`timeoutMs`、`concurrencySafe`。

**node `registry.json` 必填**：`id`（与目录名一致，builtin 用 `builtin.<name>`）、`next`（必须是已存在的 node id 或终止标记）、`type`（`core|builtin`）、`entry`。`hooks` 字段只声明可用槽位，不写具体实现。

**禁止**：两个模块用同一个 `name`/`id`；模块内部 import 另一个模块的 `run.js`（跨模块协作只能通过 core 服务或 capabilities）。

### C2 插槽契约

**channel**（`channels/contract.js` 的 `channelProblems`）：

- 字段：`type`、`instanceId`、`capabilities`；函数：`start`、`project`、`stop`；鉴权：`headers`、`invalidate`；可选 `check()`。
- `capabilities` 必填且必须真实：`eventMode ∈ {ws, webhook, reverse-ws, poll}`、`ackDeadlineMs`（正有限数，禁止 `Infinity`）、`maxTextBytes`、`outboundQps`、`streaming`、`canPromptUser`、`canAttachFiles`。
- **能力位不得预先置 true**：没实现附件就不许 `canAttachFiles:true`。

**proxy**（`proxies/contract.js` 的 `proxyProblems`）：

- 字段：`type`、`instanceId`、`scopes`；函数：`whoami`、`call`、`headers`、`invalidate`。
- proxy **没有入站**，不得声明事件回调/长连接；需要入站的能力属于 channel。

**新增驱动必须自带**：`contract.test.js` 级别的形状测试；在 `channels|proxies/*.example.json` 里补一条示例配置。

### C3 事件与结果契约

| 契约 | 形状 | 约束 |
| --- | --- | --- |
| 入站消息 | `{ eventId, conversationKey, messages, instanceId, type }` | `eventId` 非空且稳定（重投必须同值）；`conversationKey` 非空 |
| turn 事件 | `{ type: "token", delta }`、`{ type: "done", message? }`、`{ type: "error", kind, message }`、`turn-end` | 投影器只认这几种；新增事件类型需同时改 projector 与测试 |
| 错误分类 | `ERROR_KINDS = retryable / auth / platform / content` | 抛错前先 `classifyError`；`TurnError.reason` 另有一套业务原因（如 `translation-error`） |
| 工具结果 | `normalizeResult` 的三态 | 工具只返回数据或抛错，不自行拼自然语言前缀 |
| RPC 命令 | `{ name, params(JSON Schema), streaming(bool), handler }` | 传输层不认识领域命令名；流式命令必须显式 `streaming:true` |

**新增事件/错误 reason 的流程**：先在契约文档登记 → 再加枚举 → 再接投影/UI，三步分在不同 patch，避免「生产者先上、消费者后补」导致丢事件。

### C4 超时与重试预算

所有超时值集中在预算表，模块引用常量，不各自硬编码。

| 场景 | 预算 | 语义 |
| --- | --- | --- |
| 平台 ack | 由 `capabilities.ackDeadlineMs` 声明（飞书 3s） | 超时即重投，处理必须异步入队 |
| 入站单轮 | 不设硬上限，但必须有可见进度 | 超长 turn 靠卡片 patch 体现活性 |
| 翻译输入 | 20s，失败重试 1 次后降级 | 降级 = 原文直送，不阻断 turn |
| 翻译输出 | 30s，失败保留原文 | 不重试，不阻塞已生成答案 |
| 模型请求 | 60s 默认 | 超时归 `retryable`，由 loop 决定是否续 |
| 卡片节流 | 250ms | 低于该频率的变更合并成一次 patch |

重试纪律：只重试 `retryable`；`auth` 只允许「失效 → 重新取一次」；`platform`/`content` 不重试，转成对用户的可见错误。

### C5 存储契约

- **表只加不改不删**；字段只允许「新增可空列」，不允许改类型/改语义。
- 新表 = 一个新迁移文件 + `docs/foundation/storage/schema.md` 增一节；两者同一个 patch。
- 迁移文件形状：`core/storage/migrations/NNNN-<slug>.js`，导出 `{ id: "NNNN", up(store) }`；`id` 全仓唯一且按号执行。
- 跨表引用必须写明 `ON DELETE` 语义；`sessions.workspace_id` 是 NOT NULL，创建会话前必须先有 workspace。
- 不变式：`messages.surface_seq` 与 `compactions.seq` 共用同一序号空间；`session_seq_counters` 只增不减。

**号段分配**（防止两人同时取同一个号）：

| 域 | 号段 |
| --- | --- |
| channels / inbound | 0100–0129 |
| storage / compaction | 0130–0159 |
| ui | 0160–0179 |
| proxies / accounts | 0180–0199 |
| core runtime / loops / tools | 0200–0219 |
| 预留 | 0220+ |

### C6 命名与 ID

| 对象 | 规范 | 示例 |
| --- | --- | --- |
| tool 名 | 小写下划线，动词优先 | `web_fetch`、`todo_write` |
| loop node id | 小写短横线 | `assemble-input`、`model-call` |
| builtin node | `builtin.<name>` | `builtin.translate-input` |
| proxy 动作 | `域.动词` | `doc.read`、`calendar.delete` |
| 实例 id | 全仓唯一，出现在配置与日志 | `wing-bot`、`me-oauth` |
| 事件 type | 点分，命名空间在前 | `token`、`compaction:done` |
| 迁移文件 | `NNNN-slug.js` | `0101-dedupe-retention.js` |

命名冲突在契约评审阶段解决；合并阶段不接受改名。

### C7 文档契约

- 每个模块一份 `docs/<area>/<module>.md`，固定六节：**职责 / 契约 / 数据 / 失败 / 验证 / 边界**。
- 决策进 `docs/adr/NNNN-<slug>.md`：`背景 / 选项 / 决定 / 后果`，只增不改，被推翻时新开一条并标注 supersedes。
- 文档不复述代码：调用链写「谁在什么条件下调谁」，不粘贴函数体。
- 文档树遵守 `docs/README.md`：目录即导航，枝干 README 只写范围。

### C8 交付契约

每个子任务交付三件：

1. **patch**：`git format-patch -1 --stdout > <task>.patch`（本机 `api.github.com` 403，无法 push，patch 是唯一的跨环境传递方式）。
2. **变更说明**：改了什么、明确没改什么、风险点、回滚方式。
3. **验证原文**：`npm run verify` 的完整输出（不是「已通过」四个字）。

patch 必须满足：单一主题；不含 `user/` 下的任何文件（凭据与个人配置一律不进 patch）；不夹带格式化噪音；提交信息 `<域>: <一句话>`（如 `channel: filter non-mention group messages`）。

## 4 纪律

| # | 纪律 | 违反的后果 |
| --- | --- | --- |
| D1 | **单一写入区**：开工先申领路径清单，只在清单内写 | 越界改动会在合并时与别人的登记行冲突 |
| D2 | **登记行只追加**：共享文件里只在指定区块尾部加行 | 重排会导致整段 diff，评审无法分辨语义变更 |
| D3 | **号段唯一**：迁移号段按域分配，文件内自带编号 | 两个 `0101` 会让迁移顺序不确定 |
| D4 | **测试自持**：谁的功能谁写测试，不改别人的测试 | 改别人测试等于单方面改变验收标准 |
| D5 | **只增不删**：接口、字段、能力位只增不删；废弃走双写过渡 | 删接口会同时打断所有并行分支 |
| D6 | **门禁一致**：合并前必须过 `verify`，架构规则只准加不准放宽 | 规则放宽会让层级穿透悄悄发生 |

## 5 分区与 OWNERS

每个域一个负责人（可以是人或 agent），负责本域契约、登记行合并与最终验收。路径前缀即所有权边界。

| 域 | 路径 | 负责内容 | 可并行的子写区 |
| --- | --- | --- | --- |
| entry | `launcher.js`、`channel-run.js` | 组装顺序、进程生命周期 | 无（串行） |
| core-foundation | `core/index.js`、`core/agent.js`、`core/transport.js`、`core/rpc/` | 组合根、运行时、命令面 | `core/rpc/handlers/<domain>.js` |
| core-runtime | `core/loops/`、`core/context/`、`core/model/`、`core/compaction*` | 节点链、上下文、模型调用 | `core/loops/nodes/<id>/`、`builtins/<id>/` |
| core-tools | `tools/`、`core/tools/` | 工具契约与执行器 | `tools/<name>/` 每目录独立 |
| storage | `core/storage/`、`docs/foundation/storage/` | DDL、迁移、回放 | `migrations/013x-*` |
| channels | `channels/` | 插槽契约、入站 pipeline、驱动 | `channels/<type>/`、`channels/inbound/<module>.js` |
| proxies | `proxies/`、`accounts/` | 人的凭据、动作表、错误分类 | `actions/<domain>.js`、驱动目录 |
| ui | `ui/` | 渲染与 RPC 客户端 | `ui/web/<feature>-*` |
| ops | `scripts/`、`docs/ops/` | 图扫描、验证、部署 | `scripts/<tool>.sh` |

**跨域改动**：由发起方写「集成请求」（改哪个共享文件的哪一行、为什么、验证方式），交对应 OWNERS 合；发起方不在自己分支上改。

## 6 波次与子任务

### Wave 0 契约冻结（串行，1 个负责人）

产物：

1. 本文件 + `docs/adr/` 目录；
2. `scripts/verify.sh`（见 §8）+ `package.json` 的 `verify` 脚本；
3. `core/storage/migrations/` 骨架 + `schema.js` 改为按号执行；
4. `proxies/lark/actions/` 拆分（`doc/drive/sheet/im/calendar/contact` + `index.js` 合并表）；
5. 共享文件的 `// --- registrations ---` 区块；
6. `OWNERS` 表落入仓库（可与本文件同址）。

Wave 0 没完成之前，不开任何并行写代码的任务。

### Wave 1 叶子任务（可 8–10 路并行）

写区互不重叠，全部只依赖 C1–C5。

| # | 子任务 | 写区 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| 1.1 | 翻译韧性：超时重试一次、失败降级原文、卡片标注 | `core/translation.js`、`core/loops/builtins/translate-input/` | C3 C4 | 注入超时后 turn 成功；降级事件可见；2 条测试 |
| 1.2 | 群消息只处理 @ | `channels/feishu/events.js` | C3 | 非 @ 群事件 ack 丢弃；单聊不变 |
| 1.3 | 入站白名单 + 每用户限速 | 新建 `channels/inbound/policy.js` | C3 | 白名单外零 turn；限速有计数与日志 |
| 1.4 | 卡片投影：错误/降级/分条 | `channels/feishu/projector.js` | C3 | 三类事件快照测试 |
| 1.5 | 出站投递语义：检查返回 id、失败可分类 | `channels/feishu/api.js` | C4 | 403/超时返回 `retryable` 或 `platform`，不静默 |
| 1.6 | dedupe 容量与文件清理 | `channels/inbound/dedupe.js` | C5 | 容量、过期、压缩各 1 条 |
| 1.7 | 会话绑定策略可配置 | `channels/inbound/sessions.js` | C5 | 对话/用户/话题三策略测试 |
| 1.8 | 存储迁移框架 | `core/storage/migrations/*`、`core/storage/schema.js` | C5（013x） | 空库/旧库/重复执行三例 |
| 1.9 | 日志门面 + traceId | 新建 `lib/log/`，各模块只调门面 | C3 | 一条事件串起入站→turn→出站 |
| 1.10 | `doctor` 自检 | `scripts/doctor.sh` | 无 | 六项检查 + 退出码 |

合并顺序：**1.8 → 1.9 → 1.10 → 其余任意顺序**。前三项是后七项的基础设施。

### Wave 2 插槽与驱动（4–6 路并行）

| # | 子任务 | 写区 | 依赖 |
| --- | --- | --- | --- |
| 2.1 | 动作表按域补能力 | `proxies/lark/actions/<domain>.js` | Wave 0 拆分 + C6 |
| 2.2 | OAuth 刷新策略 | `accounts/`、`proxies/lark/oauth*.js` | C2 |
| 2.3 | 新渠道驱动 | `channels/<type>/` | C2 |
| 2.4 | webhook 传输 | 新建 `channels/feishu/webhook.js` | C2 C3 |
| 2.5 | 技能系统闭环 | `core/skills/`、`tools/skill/` | C1 |
| 2.6 | 子代理运行时强化 | `core/subagent-runtime.js`、`tools/subagent*/` | C5 |

2.4 与 2.3 可并行，但 `capabilities.eventMode` 的切换必须由一个人统一改配置与文档。

### Wave 3 运行时结构（串行评审，最多 2 路）

| # | 子任务 | 写区 | 顺序 |
| --- | --- | --- | --- |
| 3.1 | AbortSignal 贯通（模型/压缩/翻译取消） | `core/model/`、`core/context/`、`core/translation.js` | 第一 |
| 3.2 | event sourcing（turn/step/message 事件化） | `core/storage/`、`core/agent.js` | 第二（与 3.1 同批文件，禁并行） |
| 3.3 | 压缩裁剪器可插拔 | `core/compaction*` | 第三（依赖 3.1 取消语义） |

Wave 3 独占合并窗口，不与其它波次同时合。

### Wave 4 UI / 文档 / 运维（全程可并行）

| # | 子任务 | 写区 |
| --- | --- | --- |
| 4.1 | 轨迹面板 | `ui/web/trajectory-*` |
| 4.2 | 依赖图交互 | `ui/web/graph-*` |
| 4.3 | 窄屏适配 | `ui/web/*.css` |
| 4.4 | 子系统文档补齐 | `docs/<area>/` 各自目录 |
| 4.5 | 部署聚合脚本 | `scripts/` |
| 4.6 | 指标/健康端点 | `core/rpc/handlers/<new>.js` + 登记行 |

## 7 汇合流程

1. **申领**：任务开工前在集成请求里写「路径清单 + 号段 + 预计碰到的登记行」。
2. **开发**：只在自己的 worktree/分支上改；需要共享文件时写集成请求，不自改。
3. **自验**：`npm run verify` 全绿 + 本任务测试全绿 + `git diff --check` 无空白错误。
4. **交付**：patch + 变更说明 + 验证原文。
5. **集成**：OWNERS 按序 apply；顺序 = 基础设施 → 业务；每合一个跑一次 `verify`。
6. **回归**：合并后跑一次真机 smoke（`channel-run.js --echo` 起一条链路，发一条消息看卡片）。
7. **回滚**：`git revert <merge>` + 删除对应迁移（仅限未在任何环境执行过的迁移）。

**登记行写法**（示例，只在区块尾部追加）：

```js
// --- registrations ---
core.health = createHealthService(core);           // ops: health-endpoint
```

**迁移文件骨架**：

```js
// core/storage/migrations/0101-dedupe-retention.js
export const id = "0101";
export async function up(store) {
  await store.exec(`CREATE TABLE IF NOT EXISTS dedupe_retention (...) `);
}
```

## 8 验证门禁

`scripts/verify.sh` 草案（Wave 0 落地，并在 `package.json` 注册为 `npm run verify`；在此之前用等价命令手跑）：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. 全量单测（含契约测试）
node --test "test/**/*.test.js"

# 2. 架构守卫：层级规则 0 违规，scan 非零退出即失败
node scripts/graph/scan.js > /tmp/agent-scan.log
grep -q "[arch] clean" /tmp/agent-scan.log

# 3. 注册表唯一性与目录一致性
node scripts/verify/registry-check.js

# 4. 迁移号唯一且连续
node scripts/verify/migration-check.js

# 5. patch 卫生：不夹带 user/、无空白错误
git diff --check
if git diff --cached --name-only | grep -q "^user/"; then
  echo "user/ 不应进入提交"; exit 1
fi

echo "[verify] ok"
```

配套的三个检查脚本（Wave 0 起草）：

- `registry-check.js`：tool 的 `name` 唯一且等于目录名；node 的 `id` 唯一，`next` 必须指向已存在节点；channel/proxy 的 `instanceId` 在示例配置里唯一。
- `migration-check.js`：`migrations/NNNN-*.js` 无重复号、号段符合 §C5 分配。
- `secret-check.sh`：`git grep -nE "appSecret|clientSecret" -- ':!user/' ':!docs/'` 不得命中真实值。

失败处置：架构违规不许用例外掩盖（例外只能由 OWNERS 加，且写明理由）；注册冲突打回作者改名，不在集成阶段就地改。

## 9 试点

并行能力先用三个写区完全不重叠、且都直接改善可用性的任务验证：

| 任务 | 写区 | 合并冲突面 |
| --- | --- | --- |
| 翻译韧性（1.1） | `core/translation.js`、`builtin.translate-input` | 无 |
| 群 @ 过滤（1.2） | `channels/feishu/events.js` | 无 |
| 卡片错误/降级投影（1.4） | `channels/feishu/projector.js` | 无 |

三条都合并成功、`verify` 全绿，才按 Wave 1 铺开到 8–10 路。

## 10 不并行的边界

以下事项即使看起来独立，也不拆并行：

1. **`core/index.js` 的组合顺序**：服务之间有构造依赖（agent 需要 context，context 需要 runtime），顺序错会启动失败。
2. **schema 语义变更**：改字段含义不是加表，必须单点完成 + 数据迁移 + 回放验证。
3. **事件契约变更**：生产者与消费者必须同一个 patch，否则中间窗口会丢事件。
4. **`capabilities` 与实现的对账**：能力位置 true 只能在实现落地的那次提交里做。
5. **依赖升级**：`package.json` 与 lock 单点负责，避免「每人升一个包」。
6. **架构规则放宽**：只准加规则，放宽必须走 ADR。
