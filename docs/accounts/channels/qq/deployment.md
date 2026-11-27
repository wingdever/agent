# QQ channel 微服务部署

## 组成

两个独立进程，经 `127.0.0.1` 上的 HTTP/SSE 通信：

- **channel 服务**（`channel-run.js`）— 拥有 QQ WebSocket、SQLite WAL 消息历史、`/messages/subscribe` 与 `/proactive` 端点。不加载 core。
- **core**（`launcher.js` 或 headless）— 订阅 channel 服务的消息流，开 turn，经 `channel-send` 节点把回复 POST 回 `/proactive`。

依赖方向单向：core 依赖 channel 服务，channel 服务不依赖 core。channel 服务晚于 core 启动时 SSE 自动重连。

## 配置

### channel 服务

`scripts/channel-daemon.sh` 从 `user/channel-daemon.env`（0600，git-ignored）读取环境变量：

```
CHANNEL_RUN_ID=alice-qq
CHANNEL_ALICE_QQ_APPID=...
CHANNEL_ALICE_QQ_APPSECRET=...
CHANNEL_HISTORY_DB=/home/wing/Projects/agent/data/channels/history-alice-qq.db
```

systemd user unit 模板在 `assets/systemd/agent-channel.service`。安装：

```bash
mkdir -p ~/.config/systemd/user
cp assets/systemd/agent-channel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-channel.service
```

### core

core 必须配置 `CHANNEL_SERVICE_ENDPOINT` 才会 attach channel-listen：

```
CHANNEL_SERVICE_ENDPOINT=http://127.0.0.1:18766
CHANNEL_HISTORY_DB=/home/wing/Projects/agent/data/channels/history-alice-qq.db
```

未设置时 core 不订阅，消息只写库不触发 turn。只读 reader 用 `CHANNEL_HISTORY_DB` 以 `readonly: true` 打开同一个 SQLite WAL 文件（跨进程可读）。

channel 服务的端口由 `CHANNEL_SERVICE_PORT` 配置（默认 0 用 ephemeral port，部署时建议固定为 18766 并同步到 core 的 endpoint）。

归档目录由 `CHANNEL_ARCHIVE_DIR` 配置，默认 `data/archive/qq/`。channel-run 启动时把 90 天前**已投递**的消息按月导出为独立 SQLite 文件（`YYYY-MM.db`）并删除热表行；core 的只读 reader 同时读热库与归档库，回放不受影响。未投递消息不会被归档。

投递采用 ACK 语义，合并进 `POST /proactive`：channel 服务发布消息时只记录一次 attempt；core 的 `channel-send` 节点发回复时带 `ackEventId`，服务发送成功后一并 ACK；turn 失败则发 `status: "failed"` 只 ACK 不发送。core 重连时未 ACK 的消息重放，最多 5 次后自动丢弃。

历史上下文由 core 直接只读打开 SQLite WAL 文件读取（跨进程单写多读），无额外 HTTP 端点。`CHANNEL_HISTORY_DB` 给 channel 服务与 core 配置同一路径。

## 验证（不动真实账号）

```bash
node scripts/verify-channel-runtime.js
```

用 fake channel 驱动跑真实 HTTP/SSE 跨边界验证：注入一条消息，确认它经 SSE 到达 core 侧、且被标记为已投递。不触碰真实 QQ 凭据。
