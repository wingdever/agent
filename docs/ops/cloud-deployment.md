# 云部署与移动访问（Cloud Deployment）

## 范围

本文件定义一个**单用户、单实例、公网可访问**的 agent 服务：agent 跑在云主机上，用户从手机浏览器或 PWA 访问并与之交互。

它包含两条并行工作线，二者都围绕同一个交付物：

- **功能线（F）**：让服务在云端无头运行、能被手机访问、能完成一轮完整交互。
- **护栏线（G）**：让这个公网服务不被陌生人滥用、不泄漏凭据、不把宿主机搭进去。

两条线可以并行开发，但**公网发布必须等护栏线的 P0 项完成**。F 可以在 localhost 上先跑通；G 的入口、鉴权、能力收窄必须在上公网前生效。

不在本文件范围：

- 多用户、账号体系、用户隔离（M9）；
- 微服务拆分与跨主机编排（M7.5 的后半段）；
- Kubernetes、服务网格、多副本水平扩展；
- 完整 WAF、审计平台、SIEM；
- 原生 App、桌面 Electron 远程化、noVNC；
- Tailscale 等私有网络方案（本文按公网入口设计）。

## 1 部署形态

```text
手机浏览器 / PWA / 桌面浏览器
              │ HTTPS :443
              ▼
        Caddy（TLS、反向代理）
              │ 宿主 Caddy：127.0.0.1:18765
              │ compose Caddy：agent:18765
              ▼
        host.js（无头 host）
        ├─ 静态 ui/web
        ├─ POST /api/call        RPC + SSE
        ├─ GET  /terminal        WebSocket（默认关闭）
        ├─ GET  /healthz
        └─ core（store / tools / schedule / jobs）
              │
        Docker 卷：data / user / work
```

约束：

- **一个 core 实例**。当前存储是本地 SQLite，schedule / jobs / agent 运行时都假设单写者；不要在同一份 `data/store.db` 上跑两个 host。
- **不做水平扩展**。需要多副本时先改存储、租约、后台作业和事件总线，属于 M7.5 之后。
- **桌面端不再另起一个 core**。桌面浏览器访问云端同一个 Web 服务；本地 Electron 只用于开发，使用独立 `data/`，不能和云端共用同一数据库。
- 云端是唯一对外服务；18765 只 bind 回环，公网只开 80/443。

## 2 工作线拆分

| ID | 工作线 | 交付 | 依赖 |
|---|---|---|---|
| F1 | 无头 host | `host.js` 启动 core + HTTP，不依赖 Electron | — |
| F2 | Web 服务化 | 静态页面 + `/api/call` + `/healthz` + 同源 API | F1 |
| F3 | 移动端 presenter | 响应式聊天界面、审批、会话列表、PWA | F2 |
| F4 | 流式可靠性 | SSE 事件 id、断线重连、待交互重列 | F2；完整重启恢复依赖 session-save |
| F5 | 部署交付 | Dockerfile、compose、Caddyfile、部署脚本 | F1/F2 |
| G1 | 入口收敛 | TLS、反代、回环绑定、防火墙、SSH 限制 | — |
| G2 | 身份认证 | 单用户 token 登录、签名 cookie、API/WS 鉴权、限流 | G1 |
| G3 | 能力收窄 | 默认关闭终端/渠道、权限默认 ask、文件范围 | G2 |
| G4 | 容器与秘密 | 非 root、无宿主挂载、密钥外置、资源限制 | F5 |
| G5 | 运维底线 | 健康检查、日志、备份、轮换、kill switch | G1–G4 |

重叠点：

- **Docker** 既是 F5 的交付形态，也是 G4 的隔离边界；镜像负责“能跑”，运行参数负责“只跑到该跑的地方”。
- **TLS** 既是 G1 的入口护栏，也是 F3 安装 PWA 的功能前提。
- **同源** 既是 F2 的接口简化，也是 G2 的 CORS/CSRF 基础。

## 3 功能线

### 3.1 F1 无头 host

新增根级 `host.js`，与 `launcher.js` 分离：

- `launcher.js` 继续服务 Electron 桌面端；
- `host.js` 只做：`createCore()` → `startTransport("http", core)` → 可选启动 channels；
- 不 import Electron，不调用 `app.whenReady()`；
- 处理 `SIGTERM` / `SIGINT`：停止 channels、关闭 browser / lsp / mcp / store；
- 复用 launcher 的 proxies / channels / session binder 装配，避免复制；
- 新增 `pnpm host`。

`AGENT_PROFILE` 两档：

| profile | 用途 | 默认 |
|---|---|---|
| `local` | 本机开发，允许 127.0.0.1、无鉴权 | 当前行为 |
| `cloud` | 公网服务，强制鉴权、回环绑定、关闭终端/渠道 | 新增 |

`cloud` 启动时缺 `AGENT_AUTH_TOKEN` 或 `AGENT_PUBLIC_ORIGIN` 必须**拒绝启动**，不能静默降级。

### 3.2 F2 Web 服务化

HTTP 层只保留一个入口，路由固定：

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/` | 公开 | 静态首页 / 未登录跳转 |
| `GET` | `/login` | 公开 | 登录页 |
| `POST` | `/api/login` | 公开 | token 换 cookie |
| `POST` | `/api/logout` | 需要 | 清 cookie |
| `GET` | `/api/auth` | 公开 | 返回是否已登录 |
| `POST` | `/api/call` | 需要 | 现有 RPC，流式走 SSE |
| `GET` | `/api/interactions/pending` | 需要 | 待审批 / 待回答 / plan review |
| `GET` | `/terminal` | 需要 + 开关 | WebSocket upgrade |
| `GET` | `/healthz` | 公开 | 存活与 store 可用性，不泄漏细节 |

静态服务：

- 只服务 `ui/web` 下的文件，`realpath` 后必须仍在根内，拒绝 `..` 和符号链接逃逸；
- `index.html` 不缓存，带 hash 的 vendor 资源可长缓存；
- 不把 `user/`、`data/`、`log/` 暴露为静态目录；
- `/api/call` 与页面同源，`ui/web/api.js` 在 HTTP 页面下用 `location.origin`，不再写死 `127.0.0.1`。

SSE 保持现有 POST + `text/event-stream`，不改成 WebSocket；移动端断线恢复见 F4。

### 3.3 F3 移动端 presenter

不新建独立移动 App，先用同一份 `ui/web` 做移动模式：

- `@media (max-width: 720px)`：左栏变抽屉，聊天区全宽，composer 固定底部，留 safe-area；
- 默认只露出：会话、聊天、审批、goal 状态；
- 模型、工具、技能、权限、流程、循环、本体、终端收进抽屉或隐藏；
- 审批卡片、提问卡片、plan review 卡片必须能在窄屏上完整操作；
- 终端面板默认隐藏；手机端不作为管理入口；
- 桌面浏览器与 Electron 继续使用同一套页面，不维护第二套 UI。

PWA：

- `manifest.webmanifest`：`display: standalone`、图标、主题色、启动路径；
- iOS 补 `apple-mobile-web-app-capable`；
- service worker 只缓存页面壳与静态资源，不缓存 API / 会话数据；
- 离线只展示“需要连接服务器”，不做离线聊天。

### 3.4 F4 流式可靠性

手机锁屏、切网、PWA 切后台都会断 SSE；服务端的 turn 仍在继续。需要：

- SSE 每帧加 `id: <callId>:<seq>`；
- 每个进行中的 call 保留一个有界事件环（token / tool / approval / done / error）；
- 客户端重连带 `Last-Event-ID`，服务端从环里补发；call 已结束则直接补最终结果；
- call 未知或超过保留窗口时返回 410，客户端重新拉会话消息；
- `GET /api/interactions/pending` 返回当前未决审批 / 提问 / plan review，客户端重连后重新渲染；
- 断线不取消 turn；取消仍走现有的 interrupt / stop 语义。

边界：事件环只在进程内，进程重启后不恢复；完整重启恢复属于 `session-save`，不在本文件内。

## 4 护栏线

### 4.1 G1 入口收敛

- Caddy 终止 TLS，80 跳 443；
- Caddy 反代应用，WebSocket 自动升级；
- 应用不 publish 18765。Caddy 在宿主机时，应用只 publish `127.0.0.1:18765`；Caddy 在 compose 内时，应用完全不 publish，Caddy 反代服务名 `agent:18765`；
- 云安全组/防火墙只放 80、443、受限 SSH；
- SSH 只允许密钥，禁止密码；管理入口不经过 agent；
- `/healthz` 可公开，但只返回 `ok` / `degraded`，不返回路径、版本、配置、错误堆栈；
- Caddy admin API 不对外。

### 4.2 G2 身份认证

单用户，不做注册、不做多用户。

登录流程：

1. `AGENT_AUTH_TOKEN` 从环境或 600 权限文件注入；
2. `POST /api/login` 提交 token，常量时间比较；
3. 成功后发签名 cookie：
   - `HttpOnly`
   - `Secure`（cloud 强制）
   - `SameSite=Strict`
   - `Path=/`
   - `Max-Age=604800`
4. cookie 载荷含版本、过期时间；HMAC key 由 `AGENT_AUTH_TOKEN` 派生，轮换 token 即失效全部旧 cookie；
5. `/api/call`、`/api/interactions/pending`、`/terminal` upgrade 全部校验 cookie；失败返回 401，SSE 在建立流之前拒绝；
6. token 不放 URL、不放 localStorage、不写日志；登录失败只记 IP 与时间。

防护细节：

- 登录限流：每 IP 每分钟 5 次；API 可另设每分钟上限；
- `Origin` / `Sec-Fetch-Site` 校验 POST；只接受 `AGENT_PUBLIC_ORIGIN`；
- CORS 改为同源，不再反射任意 Origin；
- 代理场景只信任来自 Caddy 的 `X-Forwarded-For`，不盲信任客户端头；
- WebSocket 校验 cookie + Origin，失败 `close(1008)`；
- 登出清 cookie；token 轮换 = 改环境变量并重启。

不做的：注册、密码找回、OAuth 登录、多角色权限、Passkey。单用户 token 足够。

### 4.3 G3 能力收窄

`cloud` profile 的默认值：

| 能力 | 默认 | 说明 |
|---|---|---|
| terminal panel | 关闭 | `/terminal` 等于远程 shell；手机端不需要 |
| channels | 关闭 | 不接真实飞书 / QQ / 云胡 bot，避免外部入站 |
| MCP | 不配置真实凭据 | 需要时用一次性 server |
| 工具权限 | `ask` | 不默认 `full-access` |
| 文件范围 | 仅工作区 | `fs-policy` 限定到挂载的 work 目录 |
| `config.set` / 权限写入 | 登录后可访问 | 单用户管理面；不接受匿名请求 |
| browser 工具 | 可选 | 容器内独立 profile，不带个人 cookie |
| bash | 容器内 | 不挂宿主目录；不挂 docker.sock |

公网实例不启用 self-evolution / 自动改配置；需要时再单独设计审批门。

### 4.4 G4 容器与秘密

镜像：

- Node 22 多阶段构建；构建阶段装 `python3/make/g++` 编译 `node-pty`；
- 运行阶段不装 Electron；
- 非 root UID 运行；
- `cap_drop: ALL`、`no-new-privileges`；
- 根文件系统只读，`/tmp` 用 tmpfs；
- `pids_limit`、内存、CPU 限制；
- 只挂载 `data/`、`user/`、`work/`（需要技能时再加 `skills/`）；
- 不挂 `/home`、`~/.ssh`、`~/.git-credentials`、宿主机根目录、`docker.sock`；
- 不用 `network_mode: host`。

秘密：

- `user/` 与 env 文件权限 600；
- provider key 用低额度、可轮换的独立 key，不用主账号 key；
- `.dockerignore` 排除 `user/`、`data/`、`log/`、`.git/`、`reference/`、`*.env`；
- 镜像里不烘任何真实凭据；
- 云实例不绑定有价值的 IAM 角色；不让 agent 接触云元数据凭据。

隔离边界：

- Docker 是进程/文件系统隔离，不是安全沙箱；工具权限 gate 仍是唯一工具边界；
- 不挂宿主目录时，最坏情况限制在容器和三个卷；
- 不与 Hermes / 主项目共用同一台机器；同机 Docker 仍共享内核和网络。

### 4.5 G5 运维底线

- `/healthz` 检查进程与 store；Docker healthcheck 用它；
- 日志到 stdout，Docker 轮转；记录登录失败、工具名、turn id、错误；不记录 token、cookie、provider key；
- 备份 `data/` 与 `user/`；备份前停写或用 SQLite 在线备份；每季度做一次恢复演练；
- kill switch：`docker compose stop` + 撤销 provider key + 轮换 `AGENT_AUTH_TOKEN`；
- 更新：跑 `node --test`、构建新镜像、备份、替换、保留上一版镜像回滚；
- 监控模型额度与出口流量；公网无鉴权时这是主要滥用面，cloud profile 必须开鉴权。

P1 可加：Caddy 限流 / fail2ban、Cloudflare WAF、审计日志。P0 不要求 WAF。

## 5 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_PROFILE` | `local` | `cloud` 强制鉴权、回环、关闭终端/渠道 |
| `AGENT_PORT` | `18765` | 应用端口 |
| `AGENT_HTTP_HOST` | `127.0.0.1` | cloud 不允许 `0.0.0.0` |
| `AGENT_PUBLIC_ORIGIN` | — | 例 `https://agent.example.com`，用于 Origin 校验 |
| `AGENT_AUTH_TOKEN` | — | cloud 必填；随机 32 字节以上 |
| `AGENT_TRUST_PROXY` | `true`（cloud） | 只信任 Caddy 的转发头 |
| `AGENT_TERMINAL_ENABLED` | `false`（cloud） | 终端开关 |
| `AGENT_CHANNELS_ENABLED` | `false`（cloud） | 渠道开关 |

配置文件仍走 `user/`：`settings.json`、`providers.json`、`permissions.json`、`fs-policy.json`、`bash-policy.json`、`channels.json`。`user/` 不进镜像，只作为卷挂载。

## 6 数据与生命周期

- `data/store.db` 是单写者 SQLite；一个 host 实例。
- 会话、turn、step、approval 事件都在 core 内；手机只是 presenter。
- 多设备同时打开同一会话是允许的，但 v1 不做跨客户端实时广播；另一台设备刷新后看到最新消息。
- `schedule` / `jobs` 的定时器与队列在 host 进程内；host 停则停，重启按现有恢复语义处理。
- 容器重启不丢 `data/`、`user/`；临时文件与 `/tmp` 可丢。

## 7 测试与验收

### 7.1 自动化

- `test/host/auth.test.js`：无 cookie 401、错 token 401、正确登录 cookie 标志、登出、token 轮换失效；
- `test/host/static.test.js`：首页、MIME、目录穿越拒绝、`user/`/`data/` 不可访问；
- `test/host/sse.test.js`：事件 id、断线重连补发、未知 call 410；
- `test/host/ws-auth.test.js`：无 cookie / 错 Origin 的 upgrade 被拒；
- `test/host/cloud-profile.test.js`：cloud 缺 token 拒绝启动、终端/渠道默认关闭；
- 容器 smoke：非 root、无额外挂载、`/healthz` 200、重启后数据仍在。

### 7.2 手工

- iPhone Safari：登录、会话列表、发送、流式、审批、锁屏 1 分钟后回来；
- Android Chrome：同上 + 添加到主屏幕；
- 桌面浏览器：同一账号、同一会话可见；
- 外网扫描：18765 不通，仅 443；
- `curl` 无 cookie 调 `/api/call` 401；`/terminal` upgrade 被拒。

### 7.3 发布门禁

上公网前必须全部满足：

- G1：TLS 生效，18765 不外露；
- G2：API 与 WS 均鉴权，登录限流；
- G3：终端与渠道默认关闭，权限默认 `ask`；
- G4：容器非 root、无宿主挂载、镜像无秘密；
- F2：手机能打开页面并完成一轮聊天；
- F4 的“刷新/重连后不丢会话”至少达到 P0：重连拉历史，不要求逐事件补发。

## 8 分期

**P0：可公网使用的最小闭环**

F1 + F2 + F3 基础聊天 + F5 Docker + G1 + G2 + G3 + G4。  
验收：手机 HTTPS 登录、聊天、审批；无鉴权请求全拒绝；终端与渠道关闭。

**P1：移动可靠性**

F4 SSE 补发 + pending interactions + PWA + G5 日志/备份/限流。  
验收：锁屏/切网后恢复；待审批不丢；可安装到主屏幕。

**P2：加固与通知**

Cloudflare/WAF、fail2ban、Web Push 或 IM 通知、审计。  
不在 P0/P1 的发布门禁内。

**P3：M7.5 后半**

只有出现独立扩缩、故障隔离或多主机需求时，才拆 model gateway / tool executor / scheduler；当前单进程容器不拆微服务。

## 9 默认决策

| 决策 | 选择 |
|---|---|
| 用户模型 | 单用户，无注册 |
| 实例数 | 单 core 实例，不做多副本 |
| 入口 | Caddy + 域名 + TLS |
| 鉴权 | 单 token + 签名 HttpOnly cookie |
| 终端 | 公网默认关闭 |
| 渠道 | 公网默认关闭 |
| 移动端 | 同一 `ui/web` 的响应式模式 + PWA |
| 部署 | 单机 Docker Compose |
| 微服务 | 暂不拆 |
| 多用户 | 留到 M9 |

## 10 开放问题

- 域名与 DNS 用哪家；是否在 Caddy 前再加 Cloudflare；
- 终端是否给管理员保留一个独立入口，还是完全只走 SSH；
- 长任务完成通知用 Web Push 还是飞书 bot；
- 浏览器工具在容器内是否需要 Playwright 浏览器镜像；
- `session-save` 完成后，F4 是否升级为持久事件回放。
