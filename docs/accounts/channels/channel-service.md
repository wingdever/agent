# Channel 服务运行时（公共层）

> 结论先说：**不建议把所有渠道一次性改成微服务。**
> 统一的是「服务契约 + 运行时」，不是「每个渠道一个进程」。QQ 保持独立服务；飞书默认嵌入式；云湖按实例选择 `embedded` 或 `service`；`fake` 只做测试。渠道数量继续增长时，优先收敛成一个 channel gateway，而不是 N 个微服务。

## 1 两种宿主模式

同一个驱动、同一份平台协议代码，可以有两种宿主：

| 模式 | 谁持有平台连接 | 谁跑 turn | 流式 | 适用 |
|---|---|---|---|---|
| `embedded` | `launcher.js` 里的本地 manager | core 进程内 | 保留（本地 sink 直接 `project()`） | 飞书默认、单机、低延迟、需要流式 |
| `service`（别名 `microservice`） | 独立 `channel-run.js` 进程 | core 通过 SSE 拉消息后跑 | 当前仅最终文本；云湖的流式仍只在 embedded | QQ、需要独立重启/独立库/跨机、渠道进程与 core 解耦 |

`service` 不是「把 agent 搬进渠道进程」。渠道进程只做四件事：收平台事件、写消息库、暴露订阅流、接受发送调用；agent、工具、权限门仍在 core。

`options.mode` 是**平台事件模式**（云湖的 `ws` / `webhook`），`options.serviceMode` 是**宿主模式**。两者不能混写：`mode:"ws", serviceMode:"service"` 是合法组合。

## 2 公共层职责

`lib/channel-service/runtime.js` 是 QQ 服务验证后抽出的通用生命周期，QQ 与云湖试点共用：

- 实例锁：`data/channels/run-<instanceId>.lock`，原子创建，0600；同一实例第二个进程直接拒绝启动。
- 共享 bearer token：`data/channels/service-token`，0600；`CHANNEL_SERVICE_TOKEN` 可覆盖。
- SQLite WAL 消息库：入站/出站消息、去重、pending、dead-letter。
- 每日归档：启动时跑一次，之后每 24h 扫一次；默认 `data/archive/<type>/<instanceId>`。
- `/messages/subscribe`、`/interactions/subscribe`、`/proactive`、`/health` 四个端点。
- 出站历史写入、publish / markPublished、ACK；`stop()` 幂等清理 timer、manager、callback、db、lock。

`channel-run.js` 只是薄 CLI：加载实例、构建 driver deps、调用 `startChannelService()`。它不再自己写锁、SQLite、callback 或归档逻辑。

## 3 配置

在 `user/channels.json` 的实例 `options` 里加两个字段：

```jsonc
{
  "id": "ami-yunhu",
  "type": "yunhu",
  "enabled": true,
  "options": {
    "mode": "ws",                     // 平台事件模式：ws | webhook
    "serviceMode": "service",         // 宿主模式：embedded | service | microservice
    "serviceEndpoint": "http://127.0.0.1:18767",
    "servicePort": 18767
  }
}
```

- `serviceMode` 省略时：QQ 若存在全局 `CHANNEL_SERVICE_ENDPOINT` 则按历史行为走 `service`；其他驱动默认 `embedded`。
- `serviceEndpoint` 可由 `CHANNEL_<ID>_SERVICE_ENDPOINT` 覆盖；QQ 兼容全局 `CHANNEL_SERVICE_ENDPOINT`。
- 云湖要 `service` 时必须显式给 endpoint，不会回退到 QQ 的全局 endpoint。
- `servicePort` 只是 `channel-run` 的监听端口，不是云湖 webhook 的 `options.port`。优先级：`CHANNEL_<ID>_SERVICE_PORT` > `CHANNEL_SERVICE_PORT` > `options.servicePort` > 0（临时端口）。
- `service` 实例不会从 UI 的「启动」按钮或本地 manager 启动；尝试启动会报 `runs in a standalone service`，必须用 `channel-run.js`，避免同实例开出第二条平台连接。

## 4 启动云湖微服务试点

先让云湖保持 `options.mode: "ws"`，避免 webhook 需要公网入口；再把它提升为 `service`：

```bash
# 每实例端口 / 历史库 / 归档目录（都可省略，省略用默认）
export CHANNEL_AMI_YUNHU_SERVICE_PORT=18767
export CHANNEL_AMI_YUNHU_HISTORY_DB="$PWD/data/channels/history-ami-yunhu.db"
export CHANNEL_AMI_YUNHU_ARCHIVE_DIR="$PWD/data/archive/yunhu/ami-yunhu"

node channel-run.js --channel ami-yunhu
```

systemd 复用 `assets/systemd/agent-channel.service`，只改 `CHANNEL_RUN_ID`：

```ini
Environment=CHANNEL_RUN_ID=ami-yunhu
```

core 侧不需要再为云湖做特殊分支：`launcher.js` 按实例读 `serviceMode`，把 `service` 实例接到各自的 endpoint，`embedded` 实例继续走本地 manager 和 `channels.setSink`。

## 5 云湖试点的边界

- **流式**：embedded 保留云湖原来的「首条 send + 后续 edit 同一条」。`service` 试点当前只发最终文本；`channel-listen` 不把 `token` 事件经 `/proactive` 投影，避免 HTTP 频率和 final 顺序问题。要保留流式，需要单独做服务端 token 节流与 final 串行化，不是这次最小试点的范围。
- **交互**：云湖 `canPromptUser=false`，`/health` 不会声明 `interactions`；`launcher` 不会为它启用交互订阅。审批/提问仍由 core 按 `autonomous` 自动处理，不会出现「等一个点不到的按钮」。
- **多实例**：每个 `service` 实例必须有自己的 endpoint 和端口；不要用同一个全局端口跑两个实例。`launcher` 按 endpoint 分组探测 `/health`，每组独立维护 features 和监听器。
- **重启窗口**：卡片已发、final 未发时服务重启仍可能丢按钮状态；这是云湖/QQ 共有的进程内存遗留项，试点不承诺修复。

## 6 回滚

把实例的 `serviceMode` 改回 `"embedded"`（或删掉），停掉对应 `channel-run` / systemd 服务，再重启 core。嵌入式路径不需要迁移消息库；服务库可以留着排查，不会影响本地 manager。

## 7 验证

```bash
node --test test/channels/channel-service.test.js test/channels/channel-service-mode.test.js
node --test test/core/rpc/channels.test.js
node scripts/verify-channel-runtime.js
pnpm test
pnpm graph
```

`verify-channel-runtime.js` 用真实 SQLite + 真实 HTTP/SSE 验证消息与 ACK 跨进程边界；`pnpm graph` 必须保持 `arch clean`。
