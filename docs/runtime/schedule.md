# 定时任务（Schedule）

## 范围

定时任务让一个会话把「到点后给某个会话投递一条用户 follow-up」这件事持久化下来。它是 **Host 级本地功能**：Host 进程在运行时就维持一个定时器，到点调用 `agent.chat`；Host 不在运行时不投递。它不是系统 cron / systemd timer，也不是后台 Job。

与 `jobs` 的边界：

| | Schedule | Job |
|---|---|---|
| 本质 | 一条持久化的投递承诺 | 当前进程里的异步执行句柄 |
| 触发 | 时间到了，投递一条 follow-up | 工具调用立即返回 `job_...`，run 在后台执行 |
| 有输出环 / 取消吗 | 没有；投递后由目标会话自己工作 | 有 `job_output` / `job_wait` / `job_kill` |
| 谁执行 | 目标会话的下一轮 AgentRuntime | 调用方传入的 `run` |
| 生命周期 | `active` / `paused` / `ended`，可跨重启 | `running` / `completed` / `failed` / `killed` |

一句话：**Schedule 负责“什么时候叫醒谁”，Job 负责“现在替我把活干了”。**

## 1 数据模型

一张 `schedules` 表，一行是一条完整任务快照：

| 列 | 含义 |
|---|---|
| `schedule_id` | 模型侧 id，`schedule-<seq>`，唯一 |
| `title` | 展示名；`new_once` / `new` 目标也用它做新会话名 |
| `prompt` | 到点投递的正文，作为一条 user 消息 |
| `timing` | JSON，时间规则；`kind` 为 `after` / `at` / `every` / `daily` / `weekly` / `cron` / `rrule` |
| `target` | JSON；`{kind:"session",sessionId}`、`{kind:"new_once",workspaceId}`、`{kind:"new",workspaceId}` |
| `status` | `active` / `paused` / `ended` |
| `next_at` | 已提交的下一次发生时刻；不是规则投影 |
| `last_delivery` | 最近一次投递回执：`occurrenceAt` / `deliveredAt` / `targetSessionId` |
| `revision` | CAS 版本；每次编辑或投递提交 +1 |

`next_at` 用 `TIMESTAMP` 存 UTC。pgmicro 读出来是 `YYYY-MM-DD HH:mm:ss.fff`（无时区后缀），存储层在映射时补 `Z`，否则 `Date.parse` 会按宿主本地时区解释，导致提前/延后数小时。

## 2 时间规则

| kind | 参数 | 语义 |
|---|---|---|
| `after` | `after_seconds` | 从现在起正秒延迟；一次性 |
| `at` | `at`（RFC 3339 带偏移）或 `{date,time,time_zone}` | 绝对时刻；一次性 |
| `every` | `every_seconds >= 60` | 固定间隔；锚点是创建时刻 |
| `daily` | `time` + IANA `time_zone` | 每天本地墙钟时间 |
| `weekly` | `time` + `time_zone` + ISO `weekdays` | 每周指定几天 |
| `cron` | 五段表达式 + `time_zone` | 标准五段 cron；day-of-month 与 day-of-week 同时限定时取 OR |
| `rrule` | 两行 `DTSTART` + `RRULE` | RFC 5545 子集：`DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`，支持 `INTERVAL`、`COUNT`、`UNTIL`、`BYDAY`、`BYMONTHDAY`、`BYMONTH`、`BYHOUR`、`BYMINUTE`、`BYSECOND` |

墙钟规则使用 `Intl.DateTimeFormat` 做时区换算，不引入第三方依赖。DST 间隙里不存在的本地时间跳过；重叠时取较早实例；被跳过的日期自然顺延。所有搜索都有上限（4000 天 / 100000 个 rrule 候选），不会无限枚举。

`rrule` 是本项目自带的受控子集，不是完整 RFC 5545：不支持 `BYSETPOS`、`BYWEEKNO`、`BYYEARDAY`，也不支持带序数的 `BYDAY`（如 `1MO`）。需要完整规则时可换成 `cron` 或扩展解析器。

## 3 投递

`ScheduleService` 只维护一个 `setTimeout`：

1. 启动 `init()` 全量读表，不激活任何目标会话；只给最近到期的 active 任务设一个定时器。
2. 到点 `drive()` 扫描 `status=active && next_at <= now` 的任务，按 `next_at` 顺序串行投递。
3. 投递前用 `latestOccurrence(now)` 取「最近一次已发生的 occurrence」，**只补一次**，不逐次重放。Host 停机 1 小时后再启动，不会把 60 条 1 分钟任务一次性倒进会话。
4. `agent.chat` 对 busy 会话会把消息投影到下一轮队列；对 idle 会话直接跑一轮。服务只等消息被接受，不等模型答完。
5. 投递后 CAS 提交 `status` / `next_at` / `last_delivery`。重复任务推进到下一个未来时刻；一次性任务置 `ended`。
6. 投递失败（目标会话删除、resume 抛错、CAS 冲突）记 warn，不自动重试；该任务在本次进程内不再入定时器队列，重启或编辑后才会再次尝试。

投递正文固定为：

```text
[SCHEDULE REMINDER]
This is a scheduled message from the user
schedule_id_json: "schedule-1"
occurrence_at: 2026-11-23T10:01:00.000Z
reminder_prompt_json: "Run the build check and report."
```

`inputSource` 为 `schedule`，目标会话看到的是普通 user 消息，不是系统事件。

## 4 目标

| target | 首次投递 | 后续投递 |
|---|---|---|
| `this_session` | 调用方会话 | 同一会话 |
| `new_once` | 新建一个会话并记录回 `target={kind:"session"}` | 复用该会话 |
| `new` | 每次新建一个会话 | 每次新建 |

`session` 目标必须是存在、未删除、非委派子代理的会话。`new_once` / `new` 使用调用方所在 workspace；workspace 被删则投递失败。

## 5 工具契约

| 工具 | 行为 |
|---|---|
| `schedule_create` | 创建一条任务；`title`、`prompt`、`target`、`timing`，返回 id / revision / nextAt |
| `schedule_list` | 列出 Host 任务；`active` 过滤，`limit` 1–100，`offset` 分页；active 按 `next_at`，其余按更新时间 |
| `schedule_view` | 读一条任务：timing、target、nextAt、status、lastDelivery |
| `schedule_edit` | `action=update/delete`；`expected_revision` CAS；可改 title/prompt/timing/target 或 `active` 暂停/恢复 |

编辑语义：

- 改 `timing` 会从当前时刻重新计算 `nextAt`，不会保留旧的下一次时刻。
- `active:false` 置 `paused`，保留 `nextAt`。
- `active:true` 时，若 `nextAt` 已过去则重新计算；`ended` 任务必须同时给新 `timing` 才能恢复。
- 删除是硬删除；删除前仍校验 `expected_revision`。
- 冲突返回 `schedule_conflict` 和 `currentRevision`，不覆盖别人的编辑。

委派子代理不能使用这四个工具，也不能成为 `session` 目标：服务检查 `subagents` 表，返回 `subagent_session`。

## 6 边界与已知差异

- **不是 cron / systemd**：没有系统级触发器，Host 进程不在时绝不投递。
- **不是 exactly-once**：投递先落库、回执后写；崩溃窗口可能重复投递。DSH 也是同一取舍。
- **不做跨进程分发**：桌面端与通道 daemon 共用 `data/store.db` 时会各自持有自己的定时器；当前没有租约/选主。需要严格单投递时应只让一个 Host 持有 schedule 服务。
- **无自动化页面**：当前只提供模型工具，没有 `ui-schedule` 等价页面；`schedule_edit` 的暂停/恢复/删除已足以让 UI 后续接入。
- **rrule 是子集**：需要完整 RFC 5545 时再引入 `rrule` 依赖或扩展解析器，不要把当前子集说成完整实现。
- **手动立即执行**：未暴露。它需要一条不推进 occurrence 时钟的投递路径，留到 UI 一起做。

## 7 测试

`core/schedule/schedule.test.js` 7 条：

- 一次性投递只发生一次、结束后不重投、framing 正确；
- `every` 推进一个 occurrence，晚唤醒只补最近一次；
- CAS 编辑冲突、暂停、恢复、删除；
- 委派子代理不能创建/被设为目标；
- 重启后只补最近一次错过的 occurrence；
- 墙钟算术、cron/rrule 解析与 `every >= 60` 校验；
- 四个工具可加载、schema 校验可通过，且缺目标会被拒绝。

全量 `node --test` 360 项通过；工具总数 38，表总数 29。
