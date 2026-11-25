# goal 目标与自动续轮

## 范围

本文件定义 goal：一个持久的完成目标，在它处于 `active` 且续轮被授权（`armed`）时，由驱动器在同一会话里自动开启后续轮次，直到目标完成、耗尽、阻塞或被人暂停。

- **状态服务**：目标状态、阶段、轮次计数、比较并交换（CAS）与授权开关。
- **模型侧工具**：`get_goal` / `create_goal` / `update_goal`，含执行时权限检查。
- **人类控制面**：`/goal` 命令在 UI 层直接读写同一状态，不经过模型轮次。
- **续轮驱动器**：在会话空闲、目标 active 且 armed、还有轮次余量时，排一条 goal 轮次。
- **事件与投影**：`goal/change` 持久事件、严格回放、`goal` UI 投影。

与 DSH（`dsh-goal` / `dsh-tool-goal` / `dsh-goal-round-driver` / `dsh-command-goal`）保持同一通信契约：工具名、参数、返回的紧凑 JSON 形状、系统提示段落原文、三处权限分歧、续轮提示词结构、blocked 阈值语义都照 DSH。**goal 是单会话能力**：它不为其它会话排轮次、不派任务，只让当前会话一轮一轮地继续。

goal 只管单会话续轮。无人值守任务周期是一类独立的运行方式（`docs/agents/unattended.md`），它可以选择引用 goal，也可以完全不用；goal 不为它做任何设计预留。

goal 与运行时的接法是通用的轮次生命周期接口（`docs/agents/lifecycle.md`）：驱动器以轮次来源登记、订阅实例事件；运行时和 loop 节点不认识 goal。

## 1 数据模型

### 1.1 持久事实

`goal_changes` 由 goal 模块自己建表与读写（`core/goal/store.js`），通用存储层只提供插入、查询等原语，不含 goal 专属操作。

一个会话最多有一个当前 goal。每次接受的变更写一行全量快照进 `goal_changes`，当前状态由回放折叠得出：

```sql
CREATE TABLE goal_changes (
  id            integer  PRIMARY KEY,
  session_id    integer  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  revision      integer  NOT NULL,
  operation     text     NOT NULL,   -- create | edit | pause | resume | complete | block | clear | round
  goal_id       text     NOT NULL,
  objective     text,                -- block / clear / round 行为空
  max_goal_rounds integer,           -- block / clear / round 行为空
  blocked_code  text,
  blocked_message text,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
)
```

`operation=round` 不是状态变更，而是「一轮 goal 轮次被接纳」的持久记录：`revision` 记该轮携带的 goal 版本，`goal_id` 与版本一起构成该轮的接纳身份；被拒绝的预留不写行，因此不消耗轮次号。

### 1.2 回放折叠

回放从 `goal_changes` 顺序读出，得到当前 goal（`id`、`revision`、`objective`、`phase`、`maxGoalRounds`、blocked 时的 `blockedReason`）、已接纳轮数 `roundsStarted`、以及已用过的 goal id 集合。规则与 DSH 一致：

- `create` 必须是全新的 `revision=1`、`phase=active`、`roundsStarted=0` 的 goal；当前 goal 未完成时不能新建；同一个 goal id 不能复用。
- 其余变更必须把当前 goal 推进一个版本，保留定义与计数，只按操作改变允许改变的字段。
- `edit` 不改变 phase 与 blocked 原因；`pause` 只能从 `active` 到 `paused`；`resume` 只能从 `active` / `paused` / `blocked` 回到 `active`，且轮次未耗尽；`complete` 可从除 `complete` 外任意阶段进入；`block` 只能从 `active` 到 `blocked`。
- `clear` 写墓碑：不带快照，版本为当前版本 +1，回放后当前 goal 为空，已用 id 保留。
- `round` 行携带的 goal 版本必须等于当前 goal 版本且该轮号为 `roundsStarted+1`，否则整段回放失败。

回放遇到非法形状、版本不连续、非法阶段转移、时间倒流或轮次不连续时**整段判失败**：当前会话的 goal 读写统一报错，UI 投影停在最后一个合法值，并保留失败原因。

### 1.3 进程内状态

`activation`（`armed` / `disarmed`）不是持久事实：每个进程对每个会话各有一份，进程重建即为 `disarmed`。它表示「当前进程是否被授权执行自动续轮」，不代表目标阶段。所有会停止续轮的操作（pause、complete、block、clear、轮次耗尽）都置为 `disarmed`；resume 置为 `armed`。

## 2 状态机

| 阶段 | 进入方式 | 自动续轮 |
|---|---|---|
| `active` | create；resume | armed 时续，disarmed 时不续 |
| `paused` | pause；驱动器在有 goal 轮次在途时发现它被取消，于会话空闲后置 pause | 不续 |
| `blocked` | block（工具或驱动器），带稳定 code 与说明 | 不续 |
| `complete` | complete | 不续 |

- 一个 goal 未完成或未清空前不能被新 goal 取代；完成的 goal 可以被新 create 直接替换。
- 从 `blocked` 恢复只走 resume，且会清除 block 原因。
- resume 在轮次余量为零时拒绝。

## 3 工具契约

三个工具共用一套注册与同一段系统提示，返回值是同一个紧凑 JSON：

```json
{ "goal": { "id": "goal-…", "revision": 3, "objective": "…", "phase": "active", "roundsStarted": 4, "maxGoalRounds": 256, "blockedReason": { "code": "…", "message": "…" } }, "activation": "armed" }
```

无当前 goal 时为 `{ "goal": null }`。`activation` 是当前进程的实时观察值，不参与回放，也不作为状态依据。

| 工具 | 参数 | 行为 |
|---|---|---|
| `get_goal` | 无 | 读当前 goal 与 activation |
| `create_goal` | `objective`（必填）、`max_goal_rounds`（可选正整数，缺省取部署默认 256） | 创建 `active` 且 armed 的 goal |
| `update_goal` | `goal_id`、`revision`、`action`（`edit` / `pause` / `resume` / `complete` / `blocked`）、`objective`、`max_goal_rounds`、`blocked_reason` | 以精确版本做 CAS 修改 |

`update_goal` 的字段约束：`objective` 与 `max_goal_rounds` 仅对 `edit` 生效；`blocked_reason` 仅对 `blocked` 生效且必填非空，落库 code 固定为 `model-reported`；`edit` 时空串 objective 与 0 轮次上限视为未提供，至少要有一项有效替换。调用前必须先 `get_goal`，把返回的 `goal_id` 与 `revision` 原样带上；过期版本返回明确的 stale 错误而不是静默覆盖。

## 4 执行时权限

工具只在调用方是注册表里那个活着的 agent、且其轮次正在运行时执行。权限分三档：

| 调用来源 | create / edit / pause / resume | complete / blocked |
|---|---|---|
| 直接人类输入（运行时根会话当前轮次里含 `source=user` 的输入） | 允许 | 允许 |
| 当前 goal 的接纳轮（本轮首条输入是该 goal 当前版本的第 `roundsStarted` 轮） | 拒绝 | 允许 |
| 其它（子代理、驱动器之外的非人类来源、不带来源的轮次） | 拒绝 | 拒绝 |

`resume` 在工具侧拒绝 `paused` 阶段的目标：从 `paused` 恢复属于人类控制面，工具只负责把 `active` 但 disarmed 的目标重新武装。

`blocked` 在接纳轮里执行时要求 `roundsStarted` 已达到阈值（`blockedAfterConsecutiveRounds`，默认 3）；直接人类请求可以立即停止目标。阈值是机械下限，判断「同一阻塞条件是否持续」仍是模型职责。

接纳轮里成功的 `complete` 或 `blocked` 会在本步之后向模型追加一段收尾指令（`<goal_complete>` / `<goal_blocked>`）：陈述结果、已做与验证方式、下一步该看什么、需要人类提供什么；本轮不再调用工具，自动运行到此结束。

## 5 人类控制面

`/goal` 命令在 UI 命令层执行，不产生模型轮次，输出不进入模型请求：

| 输入 | 行为 |
|---|---|
| `/goal` | 显示当前目标、阶段、轮数/上限、activation、可用命令；blocked 时附 code 与说明 |
| `/goal <objective>` | 创建并武装；当前是完成态时替换为新目标 |
| `/goal edit <objective>` | 修改目标，不动阶段与 activation |
| `/goal pause` | 置 paused 并撤权 |
| `/goal resume` | 从 paused / blocked 恢复并武装；也用于会话恢复或 fork 后重新武装 active 目标 |
| `/goal clear` | 清除当前 goal，保留历史 |

控制词只在完整占满输入时生效（`/goal pause after verification` 是创建一个字面目标）。领域拒绝按稳定文案直接报错，不暴露内部 id 与版本。

不带 `source` 的输入一律视为人类输入，因此所有非人类来源（子代理任务、驱动器指令、后台通知）必须显式标注自己的来源，不能借用人类权限。

## 6 续轮驱动器

### 6.1 何时排轮次

同时满足以下条件时，驱动器为会话排一轮：

- 该会话是注册表里活着的同一个实例，状态空闲，驱动器没有在收尾，也没有别的人类输入排在前面；
- 当前 goal 为 `active` 且 armed；
- `roundsStarted` 小于 `maxGoalRounds`；
- 上一次预留已经结算（有结果或已被取消），避免同一时刻两个预留。

装入了子代理服务时，还要等该会话所有仍在推进的后代空闲，避免自动轮次与在途委派交错。

### 6.2 轮次提示词

每轮把一条 `<goal_round>` 文本块作为该轮首条输入入队，来源标为 `goal` 并携带 `{ goalId, revision, round }`：

```text
<goal_round>
Objective: "<objective>"
Round: <round>/<maxGoalRounds>

Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.
</goal_round>
```

模型看到的是完整目标与轮号，不重述此前摘要，靠会话历史自我衔接。接纳后该轮在历史里是一条普通 user 消息，后续请求逐步带上它。

### 6.3 预留与接纳

驱动器先为该 `{goalId, revision}` 预留轮号 `roundsStarted+1` 并入队提示，只有该轮作为首条输入真正进入会话、且写入 `operation=round` 的持久行之后才算接纳并消耗余量；被判定 stale 的预留不消耗轮号。接纳之前，驱动器的前置检查会对照当前 goal 再验一次版本、轮号与预留身份，不一致就拒绝这一步并把其余输入放回队列。

### 6.4 何时停止

| 事件 | 结果 |
|---|---|
| complete / pause / block / clear | 不再排轮 |
| 人类输入先于预留到达 | 自动工作让位，等会话再次空闲才排轮 |
| 轮次上限耗尽 | 驱动器写 block，code 固定 `round-limit` |
| 轮次以 max tokens 结束 | 撤权（disarmed），不自动重启；目标保持 active |
| 驱动器排轮失败 | 写 block，code `queue-failed` |
| 接纳前的步被上游拒绝 | 写 block，code `prompt-rejected` |
| 人类发起的 pause 发生在轮次进行中 | 中止当前轮次 |
| 无关的取消发生在没有 goal 轮次在途时 | 只撤权 |
| 有 goal 轮次在途时被取消 | 会话空闲后把目标置 paused，不再重启该轮 |
| 落库检查点写入失败 | 撤权，不再排轮 |

取消从不自动重整轮次。

### 6.5 人类输入与竞态

- 人的输入进入 `nextTurn` 后，驱动器把会话视为「有竞争输入」：它预留的那条提示若还没被领取就作废，直到会话再次空闲。
- 人的输入在预留之后、领取之前到达时，预留作废但不动目标状态；若它到达前该轮已被另一个来源消费，则另算。
- `edit` 只通过版本栅栏使在途预留失效，驱动器继续为新版本排轮。

## 7 会话恢复、重启与 fork

- goal 的持久部分（目标、阶段、版本、已接纳轮数）随会话恢复与 fork 原样保留。
- activation 不持久：每个进程对每个会话各有一份，初值 `disarmed`。**实例创建边**（会话在进程内第一次被实例化，也就是恢复一个持久会话、进程重启后第一次打开该会话）一律置 `disarmed`；只有工具 `resume` 或人类控制面的 `resume` 把它置 `armed`。
- 因此「重启后不自动继续」有两层含义：
  - **进程级的即时续跑**：驱动器不在启动时扫描 goal、不主动实例化会话。进程重启后，只有该会话被人类或其它动作再次实例化时，驱动器才从那一刻起判断要不要续轮。
  - **会话级的续轮授权**：即使会话被实例化，恢复出来的 active goal 也是 `disarmed`，不继续；人类发出继续指令（`/goal resume`，或明确要求模型调用 `update_goal resume`）之后才恢复自动续轮。
- fork 出来的会话同理：继承的目标是 active 但 disarmed，等人类决定是否让它自己跑。
- 驱动器装到既有会话上时从不主动武装任何目标；卸载时取消在途轮次并保证此后不再排轮。

## 8 配置

| 配置 | 位置 | 默认 | 含义 |
|---|---|---|---|
| `defaultMaxGoalRounds` | `user/goal.json`，由 goal 模块读取 | `256` | `create_goal` 未指定上限时的轮次上限 |
| `blockedAfterConsecutiveRounds` | goal 工具包（`user/toolpacks.json` 的 `goal.promptVars`，默认值在 `tools/create_goal/registry.json`） | `3` | 接纳轮里模型可自行 block 的最小轮数；同一数字写进系统提示 |

`blockedAfterConsecutiveRounds` 属于 goal **工具包**而不是 goal 服务：它同时决定提示段里的数字与工具执行时的下限校验，两处读同一份值，因此不会出现"提示说能 block、执行却不允许"。工具包的规则见 `docs/tools/toolpack.md`。

## 9 系统提示段落

三个工具共用一段 `tool:goal`（顺序 2400）：

```text
create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least <blockedAfter> consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.
```

`<blockedAfter>` 取 goal 工具包的 `blockedAfterConsecutiveRounds`。段落随工具可见性出现，只要三个工具里有一个可见就注入；工具被裁剪而段落保留会让模型按无工具可用的说明行动，两者要一起作用域。

## 10 可观察性

- `goal/change`：每次持久变更提交后发出，携带操作、精确 ref 与新的完整视图；`clear` 不带视图。
- `goal/round`：一轮被接纳（`operation=round` 行写入）后发出，携带 `{ goalId, revision, round }`。
- `goal/activation-changed`：进程内授权变化，携带当前 ref，不产生持久变更。
- UI 投影 `goal`：当前 goal 或 `null`，含阶段、轮数、上限、block 原因；会话恢复与跨端推送都读这一份，不另存状态。

## 11 驱动器的触发与挂载（经由 `docs/agents/lifecycle.md` 的接口）

### 11.1 实例

驱动器监听会话实例的生命周期，对每个活着的实例各持一份状态：当前预留（goal 版本、轮号、入队消息 id、阶段 `queued` / `claimed` / `admitted` / `cancelled` / `stale`）、是否有竞争输入、是否需要落库检查点、是否正在收尾。状态只属于该实例；实例被释放时一并丢弃。

它读到的 goal 视图必须来自注册表里同一个活着的实例：实例被替换（重建、fork 覆盖）时旧状态作废，不对新实例沿用。

驱动器用通用接口接入（`docs/agents/lifecycle.md`）：

- `runtime.registerTurnSource({ name: "goal", admit })`：会话空闲时由运行时询问，驱动器决定这一轮是否由它开；
- 订阅实例事件：`session:start`（撤权）、`turn:end`（按 §6.4 结算）、`turn:cancelled`（判定是否在途）、`inbox:queued` / `inbox:claimed` / `inbox:removed`（预留的竞争与作废）；
- 轮次上的 `turn.claim` 由驱动器解释：`model-call` 在轮首持久化点调用它的 accept，把 `operation=round` 落盘。

驱动器不依赖运行时或 loop 里的任何 goal 专用钩子。

### 11.2 触发来源

| 触发 | 作用 |
|---|---|
| 实例状态变空闲 | 结算上一次预留；若目标仍可驱动则预留并排下一轮 |
| 实例被创建 | 清掉旧预留与竞争标记；不自动武装目标 |
| goal 持久变更（create / edit / pause / resume / complete / block / clear） | 标记需要落库检查点；人类发起的 `pause` 发生在轮次进行中且驱动器不是发起方时，中止该轮 |
| 输入入队 | 不是预留那一条时置「有竞争输入」，排队中的预留作废 |
| 输入被领取 / 被丢弃 | 把预留推进到 `claimed` / `cancelled` |
| 会话事件：轮次接纳的是预留那一条 | 预留推进到 `admitted`，写入 `operation=round`，消耗轮号 |
| 会话事件：轮次结束 | 按 §6.4 处理 max tokens 与取消 |
| 接纳前的步 | 对照当前 goal 再验一次预留，不一致就拒绝这一步 |
| 实例错误 | 撤权 |
| 实例被释放 | 丢弃状态 |

### 11.3 落库检查点

goal 变更先写持久事件，驱动器在排下一轮之前先等会话把持久写入刷完，再复查 goal 版本与竞争输入。刷写失败按「落库检查点写入失败」撤权，不再排轮：宁可停下等人，也不在状态可能落后的情况下继续。

### 11.4 收尾

收尾按「先关闸、再清场」：拒绝新的预留，把每个活着的目标撤权，中止在途轮次并等实例与驱动器自己的任务都静默后才返回。收尾之后不会再有任何自动轮次被排进会话。
