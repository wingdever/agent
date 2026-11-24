# 账号接入的共享基础

## 1 两类钥匙

外部平台给两种身份发票据。这是两个插槽的根本判据，比「机器人 / 人」这种描述更硬。

| 钥匙 | 换取方式 | 代表 | 插槽 | 触发方式 |
|---|---|---|---|---|
| `tenant_access_token` | `app_id` + `app_secret` 直接交换 | 机器人（应用自身） | channel | 平台推事件 |
| `user_access_token` | OAuth 同意授权，或本地已登录的 CLI | 自然人 | proxy | 模型在 turn 内调用 |

同一个自建应用可以同时签发这两套 token，但契约上不可混用：channel 不会以人的身份写文档，proxy 不会订阅群事件。

## 2 两个插槽的分界

| | channel | proxy |
|---|---|---|
| 契约形状 | `start` / `project` / `stop` + 能力画像 | `whoami` / `scopes` / `call` |
| 入站 | 有（平台事件） | 无 |
| 生命周期 | 常驻，可断线重连 | 按需，一次调用 |
| 失败语义 | ack 超时、事件重投、发送配额 | 授权过期、scope 不足、动作被拒 |
| 特有机制 | `ackDeadlineMs`、`event_id` 幂等、每会话串行、事件投影 | 最小权限校验、归属标识 |
| 细节文档 | `channel.md` | `proxy.md` |

## 3 accounts/ 负责什么

共享层只做四件事，判据是「不做就要在两个驱动里各写一遍」。

| 模块 | 职责 | 为什么共享 |
|---|---|---|
| `auth/` | 凭据生命周期：`static`（固定头）、`appSecretToToken`（交换并缓存，失效重取） | token 过期只应在一处处理；各驱动各写一遍必然各错一遍 |
| `errors.js` | 四类错误：`retryable` / `auth` / `platform` / `content` | 决定重试、换凭据还是直接失败，不该由驱动发明 |
| `outbound/` | 出站队列（qps 节奏、退避重试、凭据恢复）+ 分段（字节上限，代码块闭合重开） | 外部平台有配额与限长，超限是发不出去，属管道问题 |
| `registry-kit.js` | 驱动发现、实例配置读取、环境变量覆盖 | 两个插槽的装配方式本就相同，重复实现会无谓漂移 |

尚未实现：`oauthRefresh` 策略（proxy 走 OAuth 直连时用，见 `proxy.md` 的两条实现路线）。

## 4 配置与凭据

两套配置文件，都在 `user/`（已被 `.gitignore` 覆盖）：`user/channels.json`、`user/proxies.json`。

- 凭据只存在于 `user/`，出了这个目录视为泄漏。
- 每个字段可用环境变量覆盖：`CHANNEL_<ID>_<FIELD>` / `PROXY_<ID>_<FIELD>`，环境变量优先。这让容器与 CI 不必把密钥落到磁盘。
- 实例的 `id` 决定环境变量前缀（大写、非字母数字转下划线）。
- 缺失配置文件等于零实例，不报错；未知 `type` 立即报错并列出已知驱动。

## 5 约束

- `accounts-is-shared`：`accounts/` 是叶子，不得依赖 core、tools、providers、任何客户端，也不得依赖它所服务的两个插槽。
- `channels-no-core-internals` / `proxies-no-core-internals`：两个插槽都只经 transport 的 `POST /api/call` 访问 core，互不依赖。
- 凭据与 token 不进日志、不进 `data/store.db` 的 log 表。

## 6 不做的事

- 不定义通用消息抽象（`sendText` / `sendCard`）：一旦定义，飞书卡片与 QQ 按钮会被压平成纯文本。
- 不在 `accounts/` 放业务逻辑：它只做「钱和管道」——凭据、配额、错误。
- 不让 `accounts/` 认识任何一个具体平台：平台知识只在驱动里。
