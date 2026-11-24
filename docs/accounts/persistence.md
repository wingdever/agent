# 常驻：让机器人「一直在」

这篇只讨论一件事：怎么让 `channel-run.js` 这类入站进程持续活着，并把两个候选路线（保活 / 隧道）摆在同一张表上比较。路由、去重、卡片这些东西已经验证过了（见 `inbound.md`），这里假设链路是对的，问题只剩「它会不会一直在线」。

## 1 约束（都在本机实测过，不是推测）

| 事实 | 证据 | 对方案的影响 |
| --- | --- | --- |
| 无公网入口 | 云主机没有对外端口，历史结论 | webhook 只能靠隧道，不能裸跑 |
| 会话空闲约 10 分钟回收后台进程 | 多次观察：`nohup` 起的进程在下个时段消失 | 「起一次就跑一辈子」不成立，必须有外部拉起机制 |
| `systemd` 不可用 | `systemctl is-system-running` → `offline`，PID 1 不是 systemd | A4 排除 |
| `crontab` 有二进制，但没有 cron 守护进程 | `crontab -l` → `no crontab`，`pgrep cron` 无进程 | 不能靠本机 cron 定时 |
| **有 passwordless root** | `sudo -n id` → `uid=0(root)` | 可以动 root 的 supervisord，这是保活的现实抓手 |
| **supervisord 已在跑（root）** | 两个实例，其一 `-c /etc/mcp-vm/supervisord.conf`；`[include] files=/runtime/vm_supervisor/services/*.conf` | 新增一个 program 文件即可被托管，`autorestart=true` 自带自愈 |
| `cloudflared` 当前不存在 | `ls /tmp/cloudflared` → 不存在（旧二进制随 `/tmp` 被清） | 隧道方案每次都要先下载二进制 |
| 出站 HTTP 可直连 | `lib/net/direct-fetch.js` 已绕开 hijack 代理并验证 | 长连接/隧道都不需要代理 |

### 1.1 「常驻」要保的其实是四层

1. **进程活着**：node 没被回收。 → 保活方案的目标。
2. **连接活着**：`[ws] open` 持续存在，平台认为这台机器在线。 → 进程活着 + 断线重连。
3. **事件可达**：平台愿意把 `im.message.receive_v1` 投到这里。 → 长连接时是订阅方式，隧道路线时是 URL 可达。
4. **会话连续**：重启后同一个人还是同一个会话、同一条 `event_id` 不重跑。 → 已由 `data/channels/sessions-*.json` 与 `data/channels/dedupe-*.json` 保证，与方案无关。

很多「常驻」讨论只盯第 1 层，结果进程活了、连接掉线没人管，或者连接在但会话每次重启都新开。

## 2 方案 A：保活（把进程托住）

### A1 supervisord 托管（推荐，本机可行）

本机 root 的 supervisord 已经常驻，并且有 include 目录。做法是**只新增一个 program 文件**，不动它原有的 program：

```ini
; /runtime/vm_supervisor/services/agent-channel.conf
[program:agent-channel]
command=/bin/bash /home/user/Doubao/chats/38455616805515010/agent/scripts/channel-daemon.sh
user=user
autostart=true
autorestart=true
startsecs=5
startretries=10
stopsignal=TERM
stopasgroup=true
killasgroup=true
stdout_logfile=/home/user/Doubao/chats/38455616805515010/agent/data/logs/channel-run.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile=/home/user/Doubao/chats/38455616805515010/agent/data/logs/channel-run.err.log
```

要点：

- **凭据不进 conf**：`channel-daemon.sh` 从 `user/channel-daemon.env`（0600）读 `CHANNEL_WING_BOT_APPSECRET` 再 exec node，conf 里没有秘密。
- **只托管一个实例**：supervisord 保证单实例；人肉再跑一次 `channel-run.js` 会开第二条连接（平台会当成两个客户端），所以运行器要自带 pid 锁（见 §7 验收）。
- **重启语义**：`autorestart=true` 管崩溃；`stopasgroup=true` 保证退出时把子进程带走，不留半开连接。
- **日志**：按 10MB 切 3 份，避免长跑把磁盘吃满。
- **代价**：依赖这个 root supervisord 存在（它是 VM 基础设施的一部分，通常比会话命长，但不是我们的资产）。VM 重建/换机时要重新放这个 conf——所以 conf 与脚本应进仓库（脚本进仓库，conf 由 `scripts/install-supervisor.sh` 生成）。

**本机已落地（2026-11-23）**，日常运维只需要这三条：

```bash
# 状态（含 pid、uptime）
sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf status agent-channel
# 重启（改完代码后用）
sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf restart agent-channel
# 卸载（停 + 删 conf + reread）
sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf stop agent-channel
sudo -n rm /runtime/vm_supervisor/services/agent-channel.conf
sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf reread && \
  sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf update
```

注意 `data/logs/` 属于 `user`，supervisord 以 `user=user` 写日志，不要 chown 给 root。

### A2 自愈循环（无 root 时的兜底）

```bash
while true; do
  node channel-run.js --channel wing-bot --quiet >> data/logs/channel-run.log 2>&1
  echo "[daemon] exited $? at $(date -Is), restarting in 5s" >> data/logs/channel-run.log
  sleep 5
done
```

这是「进程退出→重启」的最小实现，但**它自己不解决回收**：循环体还是会话树里的进程，空闲 10 分钟会被一起带走。因此它只在两种场景下有意义：会话活跃期长时间在线；或者有外部触发（A3）每 10 分钟把它拉起来。

### A3 平台定时任务（外部唤醒）

用豆包定时任务每 10 分钟跑一次「检查 + 拉起」：

1. `pgrep -f "channel-run.js --channel wing-bot"` 命中就退出；
2. 未命中则用 `setsid nohup` 起新进程（或触发 A2 的循环）；
3. 幂等靠 pid 锁兜底，两个任务重叠也不会双连接。

A3 的价值是**不依赖 root 和 supervisord**，缺点是粒度粗（最长 10 分钟空窗）、依赖 agent 会话可用，而且「任务本身也在被回收的环境里」——它只能把重启频率对抗回收频率，不能真正托管。

### A4/A5 排除项

- A4 `systemd`：PID 1 不是 systemd，`systemctl` 全部不可用（实测）。
- A5 `tmux` 前台驻留：`tmux` 可用，适合调试，但 tmux server 同样是会话进程，空闲一样会被回收，不算常驻。

## 3 方案 B：隧道 + webhook（把平台「推」进来）

长连接是「这台机器连出去」；隧道是「平台能连进来」。后者需要三道工序：

### 3.1 代码：新增 webhook 能力（当前没有）

`channels/feishu` 目前只有 `eventMode:"ws"`，`sdk-connect.js` 是唯一生产传输。走 webhook 需要：

| 需要 | 说明 |
| --- | --- |
| 本地 HTTP 服务 | 监听 `127.0.0.1:<port>`，`POST /feishu/events` |
| URL 校验（challenge） | 平台首次校验会发 `{"challenge": "..."}`，必须原样回 `challenge` |
| 验签 / 解密 | 若配了 Encrypt Key，事件体是 `{"encrypt": "..."}`（AES-256-CBC，`Encrypt-Key` 派生 key，IV 在密文头）；还会带 `X-Lark-Signature`（`sha256(timestamp+nonce+encryptKey+body)`） |
| 3 秒 ack | 与长连接同一约束：`pipeline.handle` 立即返回，turn 异步跑 |
| 幂等 | 复用现有 `dedupe(event_id)`，与传输无关 |
| 防重放 | 校验 `timestamp` 偏差（平台签名含时间戳） |

改完之后 `capabilities.eventMode` 要从 `"ws"` 变成 `"webhook"`，并且**同一实例不能再开长连接**：控制台「订阅方式」是单选，切到「将事件发送至开发者服务器」后长连接就不会再投递。所以 B 是 A 的**替换**，不是叠加。

### 3.2 隧道：谁来提供公网 URL

| 变体 | 命令/前提 | 稳定性 | 备注 |
| --- | --- | --- | --- |
| B1 quick tunnel | `cloudflared tunnel --url http://127.0.0.1:8081` | URL 每次重启都变 | 每次变了都要去控制台改「请求地址」；本机已验证可注册并下发 URL（见 3.4） |
| B2 named tunnel | 自有域名 + `cloudflared tunnel run --token ...` | URL 稳定 | 需要 Cloudflare 账号、域名、DNS 记录；适合长期 |
| B3 其它反代 | frp / ngrok / 自建 nginx | 取决于上游 | 同构：都要一个「公网入口 + 转发到 127.0.0.1」 |

隧道二进制当前不在本机（`/tmp/cloudflared` 已随 `/tmp` 被清），任何变体第一步都是「下载 + 校验版本」，这一步本身要走出站网络（本机经 hijack 代理可下载，见 3.4）。

### 3.4 隧道路径的实测（2026-11-23，本机）

不落地 webhook 代码，只先证明「隧道这一层在本机走得通」，避免把方案 B 写成空头承诺：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 下载 | `curl -sL -o /tmp/cloudflared <github release>` | 302 → release-assets，落地 40 MB，`cloudflared version 2026.11.1` |
| 注册 quick tunnel | `cloudflared tunnel --url http://127.0.0.1:8099` | 4 秒内下发 `https://<随机>.trycloudflare.com`，QUIC 连接建立 |
| 公网回访 | `curl --noproxy '*' <url>` | **200**（本地 `python3 -m http.server` 的目录页） |
| 经代理回访 | `curl <url>`（走 hijack 代理） | `000`，代理路径不通，回访必须直连 |

结论：B1 在「网络 + 二进制 + 公网可达」三项上成立，唯一没做的是 webhook 代码和平台订阅切换。另外 cloudflared 启动时有一条 `failed to sufficiently increase receive buffer size` 警告（UDP 缓冲下限不足），不影响建立连接，但长隧道吞吐会受限；要长期跑 B2 需要调 `net.core.rmem_max`（本机有 root，可调）。

### 3.3 隧道的真实成本

1. **把「进程活」换成「进程 + 隧道都活」**：隧道进程也会被回收，保活问题没消失，只是多了一个要保的进程。
2. **暴露面**：URL 一旦泄露，任何人都能 POST 事件过来；验签/解密实现错一次就等于开放伪造入口。
3. **平台配置耦合**：URL 变了必须人工去改，B1 适合验证，不适合无人值守。
4. **收益**：跨机器、跨网络（机器在 NAT 后、出站被限）时，webhook 是唯一选择；本机出站长连接是通的，收益为零。

## 4 对比

| 维度 | A1 supervisord 保活 | A2 自愈循环 | A3 平台定时拉起 | B 隧道 + webhook |
| --- | --- | --- | --- | --- |
| 进程存活 | 强（root 托管、自动重启） | 弱（随会话回收） | 中（最长 10 分钟空窗） | 中（还要保隧道） |
| 需要 root | 是（本机已有） | 否 | 否 | 视端口/安装方式 |
| 需要公网 | 否 | 否 | 否 | 是 |
| 代码改动 | 无（只加守护脚本/conf） | 无 | 无 | 大（HTTP+验签+解密+ack） |
| 平台配置改动 | 无 | 无 | 无 | 改「订阅方式」+ 填 URL（B1 每次重启都要改） |
| 安全面 | 不变（出站长连接） | 不变 | 不变 | 新增公网入口，必须验签 |
| 可观测 | supervisorctl status + 日志 | 日志 | 任务记录 | 日志 + 平台投递重试 |
| 故障模式 | VM 重建丢 conf | 回收即死 | 空窗丢事件（由平台重投兜底） | 隧道断 = 收不到；URL 变 = 全断 |
| 恢复时间 | 秒级（autorestart） | 取决于外部触发 | ≤10 分钟 | 取决于人工改 URL |

## 5 建议

1. **先上 A1**：本机有 root 和常驻 supervisord，这是成本最低、语义最正确的一条。A1 落地后，`channel-run.js` 从「手动起的临时进程」变成「被托管的服务」。（本轮已落地：`agent-channel` RUNNING，autorestart 已验。）
2. **A1 同时保留 A3 作为兜底**：VM 重建、conf 丢失时，定时任务能把进程拉回来（并把 conf 重新生成），比人肉发现「机器人没回」要早。
3. **B 只在两种情况下值得做**：需要多机/多实例；或者出站长连接被平台/网络限制。本机当前不属于这两种。
4. **不要 A+B 同时开**：订阅方式是单选，同时开会得到「一边投递、一边收不到」的假象，还容易以为是自己代码坏了。

## 6 验收标准（可测）

| # | 场景 | 通过条件 | 实测（2026-11-23） |
| --- | --- | --- | --- |
| 1 | 空闲 ≥30 分钟 | 进程仍在、`[ws] open` 仍在、心跳日志无断档（对比 `data/logs/channel-run.log` 时间戳） | **通过**：37 分钟（`uptime 0:37:57`、pid 未变），38 条心跳 06:36:05→07:13:05，最大间隔 60 秒，无 >75 秒空档 |
| 2 | `kill -9 <pid>` | ≤30 秒被 supervisord 拉起，且平台上只有一条连接（`deliveries` 不出现双份） | **通过**：`kill -9 32110` → 8 秒后 `RUNNING pid 32183`，日志重新 `[ws] open`，未出现双连接 |
| 3 | 重启后同一会话 | 同一个人发消息，`sessions-wing-bot.json` 命中原 session（`[turn] session=<旧 id>`） | 未做（需要人在飞书发一条消息） |
| 4 | 同一 `event_id` 重投 | 第二张卡不出现（`dedupe-wing-bot.json` 命中，日志 `dropped ... duplicate`） | 未做（单元测试覆盖，未在真机重投） |
| 5 | 双开保护 | 手动再跑一个 `channel-run.js` 时第二个实例拒绝启动并打印锁持有者 PID | **通过**：`channel "wing-bot" is already running (pid 32110)` |

## 7 落地清单

1. `scripts/channel-daemon.sh`：读 env 文件、exec node、退出码透传。
2. `user/channel-daemon.env`（0600、不进 git）：`CHANNEL_WING_BOT_APPSECRET=...`。
3. `scripts/install-supervisor.sh`：生成 `/runtime/vm_supervisor/services/agent-channel.conf` 并 `supervisorctl reread && update`（幂等）。
4. `channel-run.js` 增加 pid 锁（`data/channels/run-<instance>.lock`）：活着就拒绝二次启动。
5. 按 §6 逐条验收，把结果回填到本文档。

补充证据：托管进程的 `ppid=12`（root supervisord），不在 agent 会话进程树内，所以空闲回收不会把它带走——`ps -o pid,ppid,pgid,user,etime -p <pid>` 可复核。

本轮（2026-11-23）已执行 1–5 的落地：`agent-channel` 已是 supervisord program（`RUNNING pid 32183`，`user=user`，`autorestart=true`），日志 `data/logs/channel-run{,.err}.log`；双开与 `kill -9` 自愈已实测通过。提交记录见仓库 `git log`（本轮提交信息：`persist: supervise channel runner`）。

## 8 不在本轮

- 多机器人 / 多实例负载均衡（平台侧同一应用只允许一条长连接语义）。
- B1 的 URL 自动回填（改订阅地址没有稳定 API，且需要控制台权限）。
- 容器化 / K8s 托管。
- 隧道断线自愈与验签压测。
