# QQ channel 微服务部署

## 组成

两个独立进程，经 `127.0.0.1` 上的 HTTP/SSE 通信：

- **channel 服务**（`channel-run.js`）— 拥有 QQ WebSocket、SQLite WAL 消息历史、`/messages/subscribe`、`/interactions/subscribe`、`/proactive` 与 `/health` 端点。不加载 core。
- **core**（`launcher.js` 或 headless）— 订阅 channel 服务的消息流，开 turn，经 `channel-send` 节点把回复 POST 回 `/proactive`。

依赖方向单向：core 依赖 channel 服务，channel 服务不依赖 core。channel 服务晚于 core 启动时 SSE 自动重连；health probe 每 30s 重试，探测到交互能力后自动启用 supervised。

## 配置

### channel 服务

`scripts/channel-daemon.sh` 从 `user/channel-daemon.env`（0600，git-ignored）读取环境变量：

```
CHANNEL_RUN_ID=alice-qq
CHANNEL_ALICE_QQ_APPID=...
CHANNEL_ALICE_QQ_APPSECRET=...
CHANNEL_HISTORY_DB=/home/wing/Projects/agent/data/channels/history-alice-qq.db
CHANNEL_SERVICE_PORT=18766
# 可选；不设则与 core 共用 data/channels/service-token（首次 0600 自动创建）
CHANNEL_SERVICE_TOKEN=...
```

systemd user unit 模板在 `assets/systemd/agent-channel.service`。安装：

```bash
mkdir -p ~/.config/systemd/user
cp assets/systemd/agent-channel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-channel.service
```

### core

core 可以继续用全局 `CHANNEL_SERVICE_ENDPOINT`（QQ 的历史兼容），也可以在 QQ 实例的 `options` 里写 `serviceMode: "service"` + `serviceEndpoint`，按实例接入；多服务场景应使用后者：

```
CHANNEL_SERVICE_ENDPOINT=http://127.0.0.1:18766
CHANNEL_HISTORY_DB=/home/wing/Projects/agent/data/channels/history-alice-qq.db
CHANNEL_SERVICE_PORT=18766
# 可选；不设则与 core 共用 data/channels/service-token（首次 0600 自动创建）
CHANNEL_SERVICE_TOKEN=...
```

未设置时 core 不订阅，消息只写库不触发 turn。只读 reader 用 `CHANNEL_HISTORY_DB`（或实例级 `CHANNEL_<ID>_HISTORY_DB`）以 `readonly: true` 打开同一个 SQLite WAL 文件（跨进程可读）。两边必须拿到同一个 bearer token；core 启动时先 `readServiceToken() || ensureServiceToken()`，再传给 SSE 与发送调用。

channel 服务的端口由 `CHANNEL_SERVICE_PORT` 配置（默认 0 用 ephemeral port，部署时必须固定为 18766 并同步到 core 的 endpoint，否则 core 的 health probe 和 SSE 都连不上）。

归档目录由 `CHANNEL_ARCHIVE_DIR`（或实例级 `CHANNEL_<ID>_ARCHIVE_DIR`）配置，默认 `data/archive/qq/<instanceId>/`。公共运行时与云湖试点见 `docs/accounts/channels/channel-service.md`。channel-run 启动时与之后每 24h 把 90 天前**已投递**的消息按月导出为独立 SQLite 文件（`YYYY-MM.db`）并删除热表行；core 的只读 reader 同时读热库与归档库，回放不受影响。未投递消息不会被归档。

投递采用 ACK 语义，合并进 `POST /proactive`：channel 服务发布消息时只记录一次 attempt；core 的 `channel-send` 节点发回复时带 `ackEventId`，服务发送成功后一并 ACK；turn 失败则发 `status: "failed"` 只 ACK 不发送。审批/提问/计划卡不占用这条文本路径，带 `event` 字段投影后直接返回 `{ok, sent, acked:false}`。core 重连时未 ACK 的消息重放，最多 5 次后进入 dead-letter（`dead_lettered_at`），从 pending 移除但不归档；`/health` 的 `status.deadLetters` 与 journal 的 WARNING 会暴露数量，需要人工检查或 `requeueDeadLetters()` 重新入队。

历史上下文由 core 直接只读打开 SQLite WAL 文件读取（跨进程单写多读），无额外 HTTP 端点。`CHANNEL_HISTORY_DB` 给 channel 服务与 core 配置同一路径。

## 验证（不动真实账号）

```bash
node scripts/verify-channel-runtime.js
```

用 fake channel 驱动跑真实 HTTP/SSE 跨边界验证：注入一条消息，确认它经 SSE 到达 core 侧、带 token 的 ACK 回到服务、pending 归零。不触碰真实 QQ 凭据。
