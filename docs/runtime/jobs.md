# 后台作业

## 范围

后台作业（jobs）让一个工具把耗时工作交给进程内的 run，立即返回 `job_...`，等工作落定时再以一条 follow-up 轮次把结果送回会话。它解决的是「工具调用不能挂住整轮」的问题，不负责调度、重试或跨进程分发。

与 `user_jobs` 的区别：`user_jobs` 是**派给真人**的任务（`request_user_job`），没有进程内 run；`jobs` 是 **agent 自己的后台工作**，有真实执行、取消与输出。

## 1 数据模型

两张表：`jobs` 存作业事实，`job_owners` 存「哪个进程在跑」。

`jobs`：

| 列 | 含义 |
|---|---|
| `job_id` | 模型侧 id，`job_<timestamp36>_<seq36>`，唯一 |
| `session_id` | 发起会话；完成通知回到这里 |
| `kind` | 谁发起的，如 `workflow` |
| `label` | 展示名，workflow 取 `meta.name` |
| `status` | `running` / `completed` / `failed` / `killed` |
| `detail` | 一行补充，如 `2 agents`、失败原因 |
| `result` | 落定后的模型可见文本 |
| `output` | 观察流尾部，最多 200 行 / 20 KB，落定时持久化 |
| `created_at` / `started_at` / `finished_at` | 时间事实 |

`job_owners`：`job_id`、`pid`、`boot`。单独放一张表是为了避免 `ALTER TABLE`——pg-micro 会重写表的 CREATE 语句并丢掉方言标记，下次打开会失败；桌面端与通道进程共用同一个 `data/store.db`，重启恢复靠这张表判断「另一个活进程是否还在跑」。

运行中的观察流在内存里追加，`job_output` 读活跃 run 的内存环；落定后写库，读库。这样高频进度行不会每一行打一次数据库。

## 2 生命周期

1. `startJob({kind, label, sessionId, chatCtx, onEvent, run})` 先写 `running` 行，再启动 `run`。写库失败直接抛，不产生不可见的 run。
2. `run(job)` 返回 `{done, cancel?}`；`job.append(line)` 往观察环追加一行并 emit `job-output`。
3. `done` 落定为 `{status, detail?, result?}`。服务把它映射成 `completed` / `failed`；`killed` 只由取消路径产生。
4. 落定写库（`job.complete`），emit `job-update`，删除活跃记录。
5. 非 `killed` 的作业投递一次完成通知。

`run` 同步抛错、`done` reject、`done` 非 Promise，都归为 `failed`，不会把异常抛回工具调用方。

## 3 完成通知

通知是一条 `role=user`、`source=job-settle` 的 follow-up 消息，走与子代理结算相同的路径：等会话空闲后调用 `agent.chat`。内容形如：

```text
Background job job_xxx (audit) completed (3 agents).

Result:
workflow "audit" completed (3 agents).
Return value:
{...}
```

失败时给 `failed: <detail>` 加输出尾部；`killed` 不投递，避免用户主动取消后还触发一轮模型。通知失败只记 warn，不重试、不抛回作业。

会话已删除时丢弃通知。通知只投一次；投递前把 `notified` 置位。

## 4 工具契约

| 工具 | 行为 |
|---|---|
| `job_output` | 读 `job_...` 或 `ujob_...`；活跃作业返回状态 + 输出尾部，落定后返回结果 + 输出尾部；从不阻塞 |
| `job_list` | 分节列出本会话的后台作业与用户作业 |
| `job_wait` | 等 `job_...` 落定，`timeout_ms` 上限 30 s；超时返回 `running` + 输出尾部 |
| `job_kill` | 取消活跃作业（调用 run 的 `cancel`，状态置 `killed`）；终态作业只报状态 |

`workflow` 的 `run_in_background: true` 是第一个消费者：启动后立即返回 job id；阶段 / 日志 / 成员事件经 `renderProgress` 追加到观察流；完成时结果文本进 `jobs.result`，通知回到父会话。

## 5 取消与重启

- 取消是幂等的：第一次把状态置 `killed` 并调用 `cancel`；`done` 随后返回也不覆盖终态，不投通知。
- 进程退出时活跃 run 随进程消失。下次启动 `JobService.init()` 扫描仍为 `running` 的行：`owner_pid` 已退出（或为空）的改成 `failed`，`detail='interrupted by restart'`；`owner_pid` 仍存活的留给那个进程，不误杀。桌面端与通道进程共用同一个 `data/store.db`，这条判断是必要的。
- 不做续跑与检查点；作业不跨进程迁移。跨进程分发属于后续能力，不在本表语义里。

## 6 上限

| 项 | 值 | 说明 |
|---|---|---|
| 观察流行数 | 200 | 超出丢最旧行 |
| 观察流字节 | 20 KB | 与行数同时约束 |
| `job_wait` 超时 | 30 s | 工具层截断，避免挂住一轮 |
| 完成通知等待空闲 | 30 s | 超时后仍尝试入队，交给下一轮边界 |

这些是协作式配额，不是安全边界；真正的执行仍受工具权限与 fs 策略约束。

## 7 测试

- `core/jobs/jobs.test.js`：7 条，覆盖落定、失败、取消、超时、重启恢复、活进程作业不误杀、观察环裁剪与通知只投一次。
- 集成：真实 `jobs` 表 + `createWorkflowService` + `tools/workflow` 后台路径，验证 job 从 `running` 到 `completed`、结果与通知都到达。
