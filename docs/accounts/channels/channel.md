# channel 插槽设计

> 本文件是设计规划，不含实现代码。
> 现状：M1、M1.5、M2 已落地（契约、入站幂等与串行、`fake` 驱动、`feishu` 驱动；共享机制已上提到 `accounts/`）。M2 的真实群里验证待凭据，M3 起未做。
> 配套：共享基础见 `accounts.md`，自然人账号代理见 `proxy.md`，分层与插槽见 `docs/foundation/architecture.md`，调用界面见 `docs/foundation/transport.md`。

## 1 定义

**channel 是「一个已认证的外部平台账号绑定」**：持有平台凭据（app secret / token / cookie），订阅该平台的事件，调用该平台的发送接口。飞书、QQ、Telegram、Discord 都是 channel；Electron 窗口不是。

判据只有一条：**它有没有一个在外部平台上注册过的身份**。有账号 → channel；没有，只是本地界面 → host / presenter。

channel 用的是**机器人钥匙**：`app_id` + `app_secret` 直接换 `tenant_access_token`。用**人的钥匙**（`user_access_token`，走 OAuth 同意授权或本地已登录的 CLI）去代办文档、表格、日历，是另一个插槽：proxy，见 `proxy.md`。同一个自建应用可以同时签发这两套 token，但它们在契约上不可混用。

## 2 三个角色

| 角色 | 职责 | 生命周期 | 现状 |
|---|---|---|---|
| host | 启动、监督、退出时收拾 core | 拥有 | `launcher.js` + Electron main |
| presenter | 把事件流渲染成界面，处理本地交互 | 依附 host | Electron renderer、`ui/web` |
| channel | 入站外部事件、出站外部消息 | 独立生灭，可远程 | （本设计新增） |

三条禁令：

- presenter 不得拥有 core 生命周期。
- channel 不得拥有 core 生命周期；core 未起时它只是连不上，不许自己去拉起。
- 三者不得互相冒充实现同一个契约。channel 的契约以外部平台约束为蓝本（ack 时限、事件重投、多用户、发送配额），host 与 presenter 没有这些约束，强行实现会把约束稀释成可选。

## 3 插槽形态

**插槽的单位是驱动（type），配置的单位是实例（id）**。同一平台可以绑多个账号。

两类账号插槽共用一层基础（`accounts/`），各自只保留自己特有的部分：

```
accounts/                 两个插槽共享
├── auth/                 凭据生命周期（static / appSecretToToken）
├── outbound/             出站队列（限流、退避）+ 分段
├── errors.js             错误分类（retryable / auth / platform / content）
└── registry-kit.js       驱动发现、实例配置、环境变量覆盖

channels/                 本插槽
├── contract.js           契约 typedef、assertChannel()
├── registry.js           按 type 发现驱动：channels/<type>/index.js
├── session-namespace.js  三段会话键
├── inbound/              幂等（event_id）与每会话串行管道
├── fake/                 假平台驱动（无凭据可跑，兼作测试基座）
├── feishu/               飞书机器人驱动（见第 13 节）
│   ├── index.js          装配：auth + api + projector + transport
│   ├── events.js         事件 → InboundMessage（唯一懂线上格式的地方）
│   ├── token.js          app_id/secret → tenant_access_token
│   ├── api.js            建卡 / 改卡，过 accounts/outbound 队列
│   ├── projector.js      一轮 turn → 一张卡片
│   ├── transport.js      长连接（JSON 帧 + 退避重连）
│   ├── sdk-connect.js    官方 SDK 适配器（protobuf 帧走这条）
│   └── fake-platform-server.js  假飞书平台（测试夹具）
└── qq/                   M4
```

驱动暴露 `createChannel(instance, deps)`，由 registry 装配。与 `providers/` 同构：provider 是「带 key 的外部模型服务」，channel 是「带 token 的外部消息平台」，两者都是「凭据 + 端点 + 能力声明」。

## 4 配置与凭据

配置文件 `user/channels.json`（`user/` 已被 `.gitignore` 覆盖）：

```jsonc
{
  "channels": [
    {
      "id": "feishu-main",          // 实例键，会话命名空间的一段
      "type": "feishu",             // 驱动键
      "enabled": true,
      "trust": "owner",             // owner | allowlist | readonly，决定权限门默认
      "credentials": { "appId": "cli_xxx", "appSecret": "xxx" },
      "options": { "eventMode": "ws" }
    }
  ],
  "limits": { "maxInFlightPerSession": 1, "maxInFlightGlobal": 4 }
}
```

凭据边界：**凭据只存在于 `user/`，出了这个目录视为泄漏**。驱动收到的只是注入的凭据对象，不允许自己读磁盘。这一点与 `user/providers.json` 的既有做法一致，也让同一驱动接两个实例成为可能。

凭据也允许由环境变量注入（便于容器与 CI）：`CHANNEL_<ID>_<FIELD>` 优先于文件。

## 5 契约

```js
/** 入站消息，已归一化 */
/**
 * @typedef {Object} InboundMessage
 * @property {string} type            // 实例 type
 * @property {string} instanceId      // 实例 id
 * @property {string} conversationKey // 平台侧会话键（chat_id / channel_id / dm 对）
 * @property {string} eventId         // 平台事件幂等键；无则驱动自行生成并保证稳定
 * @property {string} senderId        // 平台侧发送者 id
 * @property {Array<{role:string, content:string}>} messages
 * @property {Object} raw             // 平台原始载荷（入库前须裁剪）
 */

/** 能力画像：驱动声明自己受什么约束 */
/**
 * @typedef {Object} ChannelCapabilities
 * @property {"ws"|"webhook"|"reverse-ws"|"poll"} eventMode
 * @property {number} ackDeadlineMs      // 入站 ack 时限；未知则填平台文档值，不许填 Infinity
 * @property {number} maxTextBytes       // 单条出站上限
 * @property {number} outboundQps        // 出站速率上限
 * @property {boolean} streaming         // 能否流式更新（飞书卡片 patch）
 * @property {boolean} canPromptUser     // 能否就权限门向人提问
 * @property {boolean} canAttachFiles
 */

/** 凭据生命周期 */
/**
 * @typedef {Object} ChannelAuth
 * @property {() => Promise<Record<string,string>>} headers  // 出站前取鉴权头
 * @property {() => Promise<void>} invalidate                 // 收到 401/鉴权失效码后作废缓存
 */

/**
 * @typedef {Object} Channel
 * @property {string} type
 * @property {string} instanceId
 * @property {ChannelCapabilities} capabilities
 * @property {ChannelAuth} auth
 * @property {(onMessage:(m:InboundMessage)=>Promise<void>, onInteraction?:(i:Object)=>void)=>Promise<void>} start
 * @property {(m:InboundMessage, event:Object)=>Promise<void>} project   // 事件流投影
 * @property {()=>Promise<void>} stop
 */
```

`assertChannel(impl)` 校验：字段齐备、能力值非投机（`ackDeadlineMs` 必须为正数）、`start` 不许在回调里阻塞超过 `ackDeadlineMs`。

`onInteraction` 是可选的第二个入参：只有声明 `canPromptUser: true` 且平台能回调按钮的驱动才会用到。它不是消息入口，按钮点击不能进 `pipeline`，否则会把「一次点击」误当成「一句新话」再跑一轮。

## 6 共享层只做四件事

契约薄的判据：只有这四样进共享层。

| 共享职责 | 为什么必须共享 |
|---|---|
| 凭据与鉴权生命周期 | token 过期只应在一处处理；`tenant_access_token` 有效期约 2 小时，各驱动各写一遍必然各错一遍 |
| 出站队列 + 限流 + 退避 + 分段 | 外部平台有配额与限长，超限是**发不出去**，属管道问题不在表达问题 |
| 会话命名空间 | 两实例各自会话，必须有三段键，否则串话 |
| 错误分类 | `可重试 / 凭据失效 / 平台拒绝 / 内容超限` 四类决定不同处置，驱动不该各自发明 |

**分段放在共享层**：按 UTF-16 长度或字节上限切分，且不切断代码块与表格；但「切成几条、每条长什么样式」归驱动。

**不做通用消息抽象**。共享层不定义 `sendText/sendCard` 一类词汇。一旦定义，能力必然退化成各平台最小公倍数，飞书卡片、QQ 按钮全被压平成纯文本。

## 7 会话命名空间

```js
sessionId = `ch:<type>:<instanceId>:<conversationKey>`
```

- 取原串不哈希：可读、便于按 id 查库排查。
- 群聊与私聊同 `conversationKey` 时不得共用（私聊键加 `dm:` 前缀由驱动负责）。
- 每会话串行：同一 `sessionId` 同时只允许一个 turn 在跑（`maxInFlightPerSession = 1`）。外部平台会重投，并发同一会话等于自己打自己。

## 8 事件模式与部署前提

| eventMode | 平台例子 | 部署前提 | 本沙箱可用 |
|---|---|---|---|
| `ws`（长连接，自己向外连） | 飞书 | 只需出网 | 是 |
| `webhook`（平台回调） | QQ 官方机器人、多数平台 | 必须公网 HTTPS 入口 | 否 |
| `reverse-ws`（本地反连） | OneBot | 与实现同机或同网 | 视部署 |
| `poll` | 无事件接口的平台 | 只需出网，代价是延迟与配额 | 是 |

`eventMode` 是实例配置项，不是契约假设。选 `webhook` 即等于声明「我这个实例必须在有公网入口的机器上跑」——这一条要写进部署说明，否则一定有人在沙箱里配 webhook 然后困惑为什么不通。

## 9 入站时序

```
平台事件 → 驱动解析为 InboundMessage
        → 幂等检查（eventId 已处理则丢弃）
        → 立即 ack（≤ ackDeadlineMs，不 await turn）
        → 入会话串行队列
        → 经 transport 调 core.chat.send（SSE 消费事件流）
        → project() 把事件投影为平台消息（token 节流 / 工具进度 / 终态）
```

**幂等**：`user/channels-state/<id>/seen.json`，保留最近 N 条 eventId + TTL。放 channel 侧不入 core 库，理由：幂等是渠道事实，core 无此概念；也避免为它改 core schema。

**ack 与 turn 必须解耦**：单轮 turn 实测约 60 秒，而飞书要求 3 秒内 ack。同步等待必然被重投，重投再触发一轮，token 与落库都翻倍。

## 10 安全

- 凭据、`tenant_access_token`、cookie 一律不进日志，不进 `data/store.db` 的 log 表。
- `raw` 入库存前裁剪：群消息可能含他人隐私，只留路由所需字段。
- `trust` 决定权限门默认：

| trust | 含义 | 权限门 |
|---|---|---|
| `owner` | 实例主人本人使用 | 等同本机：可 ask，`canPromptUser` 为真时用平台交互，否则文字回复 |
| `allowlist` | 白名单群/人 | 名单内可 ask（文字回复），名单外 all deny |
| `readonly` | 任何人 | 工具调用全 deny，纯问答 |

本项目不实现 sandbox，安全边界只有权限门。channel 进来的是网络上的陌生人，默认值必须比本机更保守——`readonly` 与 `allowlist` 是默认候选，`owner` 需显式配置。

## 11 与分层的对接

- channel **只能经 transport 访问 core**（`POST /api/call`，`fn=chat.send`，SSE 收事件）。不许 import core、不许读 `data/`。
- 这条落成可执行规则：`arch-rules.json` 增 `channels-no-core-internals`，severity error，与现有 9 条同等待遇。
- 收益：channel 可远程连另一台机器的 core；Electron 走 ipc、飞书走 http 能共存；渠道逻辑不可能渗进 core。

## 12 测试

`fake/` 是一个受约束的假平台驱动：无凭据、内存态、可注入「重投同一 eventId」「鉴权失效」「超长文本」三种故障。

断言清单（`channels/*.test.js`）：

1. `assertChannel` 对缺字段/投机能力值报错。
2. 同一 `eventId` 二次投递被丢弃，只跑一轮 turn。
3. 同一会话并发投递两条，第二个排队而非并行。
4. ack 在 `ackDeadlineMs` 内返回，turn 未完成。
5. 超限文本按分段规则切分，不切断代码块。
6. 401 触发 `invalidate()` 并重取鉴权头后重试一次。
7. 四类错误各自映射到正确的处置（重试/停实例/上报/分段重发）。

## 13 M2 落地：飞书机器人驱动

七个文件，职责单一，平台差异全部收在 `channels/feishu/` 内：

| 文件 | 职责 | 关键决定 |
|---|---|---|
| `index.js` | 装配 | 传输经 `deps.connect` 注入；默认接真平台，测试换假平台 |
| `events.js` | 事件 → InboundMessage | `raw` 只留路由字段；`sender_type !== "user"` 直接丢（防自问自答） |
| `token.js` | 取 tenant token | 只管取；缓存与失效归 `accounts/auth` |
| `api.js` | 建卡 / 改卡 | 两个操作都过 `accounts/outbound/queue`，401 由队列换 token 后重试 |
| `projector.js` | 一轮 → 一张卡 | token 按 `throttleMs` 节流；terminal 事件强制落最终内容；`error` 也落卡（不留「正在输入」） |
| `transport.js` | 长连接 | JSON 帧 + 指数退避重连，给假平台与自建网关用 |
| `sdk-connect.js` | 官方 SDK 适配 | 把 SDK 展平后的 payload 还原成 `{schema,header,event}` |

三条结论来自实测，不是推断：

1. **SDK 具名导入成立**。`@larksuiteoapi/node-sdk@1.76.0` 没有 `exports` 字段、`main` 是 CJS，但在 `"type": "module"` 工程里 `import { WSClient, EventDispatcher, Domain, LoggerLevel }` 可用（cjs-module-lexer 能静态识别）；`new WSClient({appId, appSecret})` 构造成功，原型上有 `start/close/getConnectionStatus`。
2. **SDK 交给 handler 的不是原始 envelope**。`RequestHandle.parse` 对 v2 事件做 `{ event_type, ...header, ...event }` 展平：`event_id` 在顶层，`sender/message` 仍嵌套。所以 `toEnvelope` 这一层不可省，否则每条事件都会因「缺 event_id」被管道拒掉。
3. **Node 22 自带 WebSocket 客户端**，假平台服务端只需 60 行握手 + 文本帧，因此 `ws` 不进依赖；唯一新增依赖是官方 SDK（29MB，已在 `dependencies` 声明）。SDK 的 `protobufjs` 构建脚本被 pnpm 默认拦截，但运行时不依赖它。

假平台（`fake-platform-server.js`）复刻三条接口——token 交换、建消息、PATCH 消息——外加一条 JSON 事件长连接；故障开关只有 `rejectTokenNext`（模拟 token 失效）。

M2 的断言落点（`channels/feishu/*.test.js`，19 条）：

- 一条消息 → 恰好一张卡，末次内容等于完整回复；
- 同一 `eventId` 重投 → 只跑一轮、只建一张卡；
- 机器人自己的消息 → 不回复、不发卡；
- token 失效能换能重试（`tokenRequests === 2`，消息仍送达）；
- 两个会话各一张卡，内容绝不混；
- 节流窗口内不 PATCH，terminal 一定 PATCH 且带全文；
- SDK 展平 payload 能还原并解析出正确的会话键。

未做：真实群里跑通（需 appId/appSecret）；`trust` 与权限门的接线（M3）。

## 14 通道生命周期：不自动启动

**通道的启动不是启动应用的一部分。** 一个 channel 的 `start()` 会在远端平台上留痕：长连接建立、机器人被标记在线、事件开始投递。这种对外宣告必须是人的决定，不能是「顺手打开了 app」的副作用。所以这里没有 `autostart` 开关——没有这个开关就是设计本身。

配置里的 `enabled` 只回答一个问题：**这个实例是否被构建**。`enabled: false` 等于这个账号不存在；`enabled: true` 等于「可用但未连接」。

| 文件 | 职责 |
|---|---|
| `channels/registry.js` | 发现驱动、读配置、构建实例、按契约断言。只构建，不调用 `start()` |
| `channels/manager.js` | 持有状态机与消息入口：`stopped / starting / running / stopping / error` |
| `core/capabilities.js` | 把 manager 作为 `capabilities.channels` 交给工具。给的是**manager**，不是实例快照——状态必须由拥有它的对象回答 |
| `tools/channels/` | 模型可调的动作：`list` / `status` / `start` / `stop` |
| `launcher.js` | 构建 manager，注入 sink（一次入站消息 = 一次 `agent.chat`），并打印 `channels=N configured, none started` |

五条实现约束：

1. **start 单飞**。并发两次 `start(id)` 只建立一个连接，第二次拿回同一个 promise。平台侧看到两个连接会当成重复会话，旧的那个又会继续投递事件。
2. **mid-start stop 必须落地**。`stop()` 在 `starting` 期间到达时置 `stopRequested`，等 start 成功后再关连接；否则驱动会把连接建完就撒手。
3. **入站仍走管道**。`manager.start` 给驱动的 handler 只做一件事：把消息喂进 `channels/inbound/pipeline.js`（eventId 幂等 + 单会话串行），同步返回即 ack。重复投递只跑一轮。
4. **失败要看得见**。`start` 失败 → 状态 `error` + 抛错给调用方；一轮 turn 失败 → 仍然投影一个 `error` 事件，卡片不能停在「正在输入」。停止后清空 pipeline，重启的幂等窗口从空开始——不持久化去重记录，跨重启重投会再跑一次，这是有意的取舍（状态存在进程里，重启后如实反映）。
5. **凭据只在 start 时检查**。驱动可以声明一个可选的 `check()`，返回「现在启动会失败的原因」（飞书是 `credentials.appId` / `appSecret` 缺失，文案里带对应环境变量名）。管理器只在 `start()` 里调它：缺凭据 → 状态 `error`、抛 `channel "<id>" cannot start: …`、**不发起任何连接**；配置里没有凭据但没人启动它，则只是「未连接」，不影响启动。这是为了让「先写好配置、明天再填 secret」成为合法状态。

断言：`channels/manager.test.js` 12 条（不自动启动、start 后消息直达 sink 并投影、重投只跑一轮、start 幂等、stop 后拒绝投递、mid-start stop、无 sink/未知 id/驱动失败、turn 失败仍投影、凭据缺失时拒绝且不建连接、补上凭据后可重试成功、check 只在 start 时被问、stopAll、重复实例 id 拒绝）；`channels/feishu/feishu.test.js` 8 条（含缺凭据能构建但拒绝启动、环境变量提示、无凭据时连接数必须为 0）；`tools/channels/channels-tool.test.js` 7 条（list、单实例省略 id、多实例必须点名、status/stop 只作用于点名的实例、未知 id、无 capability、未知动作）。

启动冒烟实测：`[launcher] channels=0 configured, none started` + `[http] listening`，配置里没有通道时管理器就是空的；再配一个 `credentials: {}` 的飞书实例启动，输出 `channels=1 configured, none started`，不报凭据错误——启动不需要 secret，只有 start 需要。

未做：真实飞书群端到端（需 `appId`/`appSecret`）。

## 14.5 M4 落地：云湖（yunhu）驱动

云湖是验证「插槽」的第二个驱动，代价是它换了一个**事件模式**：飞书用长连接把事件推给我们，云湖则有两种互斥的投递方式——**长连接**（我们主动拨 `wss://ws.jwzhd.com/subscribe?token=…`）或**服务器事件推送**（平台 POST 到我们自建的 webhook）。控制台里是二选一，选哪个就只有哪个能收到消息。

默认选长连接：它不需要公网入口、不需要隧道、也不需要一个能解析的域名。[^yh-mode]

| 项 | 云湖的答案 | 影响 |
|---|---|---|
| 网关 | `https://chat-go.jwzhd.com/open-apis/v1` | `/bot/send`、`/bot/edit`、`/bot/recall`、`/bot/messages`、`/bot/info`、`/bot/groups` |
| 鉴权 | `token` 放在 **query string**（`?token=<bot_token>`），不是 header | 请求日志、错误信息里都可能带明文 token；`auth.headers()` 为空，`invalidate()` 是空操作 |
| 成功码 | `code === 1` | 不是 0。第一版按 0 判成功，对真实网关**每次都会抛错**，但对自家假平台全绿 |
| 错误语义 | 失败也回 **HTTP 200**，只有 `{code,msg}` 区分 | 出站队列不能看状态码；`1003` 是「非法token」，判 AUTH |
| 发送响应 | `{"code":1,"data":{"messageInfo":{"msgId":"…","recvId":"…","recvType":"…"}}}` | msgId 在 `data.messageInfo.msgId`，流式编辑靠它 |
| 编辑 | `/bot/edit` **必须**带 `msgId` + `recvId` + `recvType`，且与原消息一致 | 少一个就 `1002 recvId值错误，值不能为空` |
| 凭据 | 只有 bot token，**没有用户级 OAuth** | `proxy` 插槽对云湖留空。不做 cookie 伪造——那是把别人的账号当机器人的钥匙用 |
| 事件 | 事件体**不含 bot_id** | 多机器人必须各配独立订阅，并在本地配置写死自己的 botId，用来过滤自己的回声 |
| 事件名 | `message.receive.normal` / `message.receive.instruction` / `group.join` / `button.report.inline` 等 | 只处理前两类文本消息 |
| 群可见性 | 机器人能看到**群里所有消息**，不只是 @ 它的 | 一个群聊机器人默认会回应每一句话；「只在被叫到时回答」只能自己按 `content.at` 过滤（默认已这么做） |
| @ 提及 | `content.at` 是被 @ 的用户 ID 数组，没人被 @ 时**这个键不存在**；文本里 @ 与正文之间是零宽空格（U+200B） | 门必须把「没有这个键」当「没被 @」；剥掉 @昵称后还要清掉零宽字符，否则模型会收到一个看不见的字 |

六条实现取舍：

1. **长连接是默认，webhook 是备选**。`options.mode` 只有两值；`ws` 走 `ws-client.js`，`webhook` 走原来的 HTTP 监听。驱动不会同时开两条——控制台本来也只推一条，同时开只会得到一个永远收不到事件的监听器。
2. **断线必须自己重拨**。socket 是这条通道的全部入站路径，静默失联比明确报错更糟。退避 1s→2s→…→30s，`stop()` 之后不再重拨；首连超时则 `start()` 如实失败。
3. **自回环必须滤掉**。`senderId === botId` 的消息就是自己刚发出去的那条。不滤会形成「自己回自己」的无限循环，这是所有机器人驱动最容易踩的坑。
4. **群聊回群，私聊回人**。`chatType === "bot"` 是私聊；否则是群。群聊的回复必须发 `conversationKey`（chatId），发给 `senderId` 等于把答案贴到某个人脸上。
5. **群聊默认要求被明确叫到**。`requireMention` 默认 true：群消息要么 `content.at` 含本 botId，要么是 `instruction` 事件，否则丢弃；私聊（`chatType === "bot"`）不受限。平台把群里每句话都推给我们，这个门是「什么时候该开口」，与飞书 `trust` 管的「谁有权让它做事」不是一回事。
6. **首条 token 立即发送，之后编辑同一条**。平台没有「正在输入」接口，进度只能靠消息本身。第一条增量 `send` 拿到 `msgId`，后续按 `throttleMs` 走 `edit`（带上 `recvId`/`recvType`）；`msgId` 拿不到就退化成「只发一次，不编辑」。
7. **静态 token 不做重认证重试**。`createStaticAuth` 带 `rotates: false`，出站队列据此跳过「invalidate 后重试」——固定 token 换不出新 token，重试只会撞同一个 1003。

**实机证据**（真 token、真群 `agent-dev` / 846015667、机器人 `ami` / 83683850）：

- 长连接帧：`header.eventType` + `event.{sender,chat,message}`，`content` 里没有 `at` 键（那条没人被 @），`instructionId` 为 0——与第三方适配器反推的结构一致。
- 群消息全量可见：机器人**不在线**时，用 `/bot/messages` 也读得到群里没 @ 它的两条「测试」。这从 API 侧证实了可见性，不是「只在被 @ 时才推」。
- `send` → 拿到 `msgId`，`edit` 同一条 → 群里显示被改后的文本（`successCount: 1`）。
- 端到端：一条群消息 → socket → 管道 → `/bot/send` → `/bot/edit`，群里最终只有**一条**机器人消息，内容是编辑后的完整回复。
- @ 帧：`{"content":{"text":"@ami ​看看","at":["83683850"]}}`——`at` 是纯 ID 数组，文本用零宽空格分隔昵称与正文，`instructionId` 仍为 0。

断言：`channels/yunhu/yunhu.test.js` 15 条（契约与默认 ws、webhook 可选并能起监听、真实抓包帧可直接解析、socket 端到端 + 断线重拨 + 控制帧计入 ignored、凭据只在 start 检查、私聊/群聊回法、回声与非文本过滤、重投只跑一轮、增量编辑同一条、`messageInfo.msgId`、edit 缺 recvId 被本地拒绝、坏 token 判 AUTH 且只打一次、群消息 @ 门 + 指令事件放行 + 私聊豁免、`@昵称` 剥离后不留零宽字符、端点 405/404/403 三道门）。

未校准（仍需实测）：`/bot/edit` 的真实限速；长连接是否有心跳及其周期（目前只观察了 20 分钟空闲不主动断开）。

## 14.6 M4 落地：QQ 官方机器人（qq）驱动

第三个驱动，也是插槽的**第二次验收**：它换了鉴权方式（header + appsecret 换 token，有效期 2 小时）、换了事件协议（opcode 状态机）、也换了「回复」的定义（被动消息必须带收到的 `msg_id`）。结论：只加 `channels/qq/` 目录，共享层只做了**加法**（`createAppSecretTokenAuth` 多接受 `headerName`/`format`/`expiryMarginMs`），没有为 QQ 改任何既有行为。[^qq-shared]

选官方机器人而非 OneBot：官方路线是合规的 bot 身份，`WebSocket` 模式「不依赖公网服务器部署，适合个人单机使用」；OneBot 走个人号，有封号风险且要求常驻一个 QQ 客户端。[^qq-ws]

| 项 | QQ 的答案 | 影响 |
|---|---|---|
| 入口 | 后台「事件订阅与回调」在 **WebSocket / Webhook** 之间二选一 | 与 Cloudflare 同一类坑：选错就两边干等 |
| Webhook 限制 | 只允许 80/443/8080/8443 端口 + 签名校验 | 本机没有公网入口、也不能占这些端口 → 只能走 WS |
| 鉴权 | `POST https://bots.qq.com/app/getAppAccessToken`（`appId`+`appSecret`）→ `{"access_token":…,"expires_in":"7142"}` | `expires_in` 是**字符串**，且只有 7142s；必须提前换，不能等 401 |
| 出站头 | `Authorization: QQBot <access_token>` | 头名前缀是 `QQBot `，不是 `Bearer` |
| 网关 | `GET https://api.sgroup.qq.com/gateway/bot` → `{"url":"wss://api.sgroup.qq.com/websocket","shards":1,"session_start_limit":{…}}` | `/gateway` 已废弃，用 `/gateway/bot` |
| 协议 | opcode 状态机：`0 Dispatch` / `1 Heartbeat` / `2 Identify` / `6 Resume` / `7 Reconnect` / `9 Invalid Session` / `10 Hello` / `11 Heartbeat ACK` | 不是「连上就推事件」，连上只给 Hello，还得自己 Identify |
| 心跳 | `Hello.d.heartbeat_interval` = **41250ms** | 间隔随连接下发，不能写死 |
| 群消息 | 默认只推 **`GROUP_AT_MESSAGE_CREATE`**，`content` 已自动剥掉 @ 前缀 | 「只在被叫到时开口」由平台保证，驱动不必再做 @ 门 |
| 全量群消息 | 仅当群主允许机器人接收全部消息时，才有 `GROUP_MESSAGE_CREATE` | 想读群里所有话，得让群主在群设置里放开 |
| 去重 | 同一个 `msg_id` 可能重复推送 | 靠共享 `dedupe` 挡；同一 `msg_id` 的多条回复用 `msg_seq` 递增 |
| 回复 | 平台叫「被动消息」：**必须带**收到事件的 `msg_id` | `msgId` 不是可选装饰，缺了就是 400 |
| 编辑 | **没有** bot 消息编辑接口 | `capabilities.streaming=false`，流式进度在这条通道上不存在 |
| 主动推送 | 有独立配额（按月/按天），与被动消息分开 | 目前只做被动回复，不碰配额 |

七条实现取舍：

1. **appsecret 换 token，token 由共享层缓存**。`createAppSecretTokenAuth` 原来只服务飞书（`Authorization: Bearer`、按 `expire` 秒数过期）。QQ 需要头名与前缀都不同，所以给共享 auth 加了 `headerName`/`format`/`expiryMarginMs`，并允许 `fetchToken` 返回 `{token, expiresInMs}`。飞书路径不传这些参数，行为逐字不变——这是「加法而非改动」的具体含义。
2. **先 Hello 后 Identify，Resume 优先于重新 Identify**。收到 op10 才发 op2（或 op6）。有 `session_id` + `seq` 时发 op6 续上会话，没有才发 op2 重建；op9 到达即清掉 session 再 Identify。丢了 session 会重复收到消息，这正是去重存在的理由。
3. **断线由驱动自己重拨，且重拨失败不许变成未处理异常**。`close` 后 `reconnectDelayMs` 再拨；拨号返回的 ready promise 没人 await，所以必须自己 `.catch` 成 `errors` 计数再排下一次。第一版只在测试里暴露了这一点（`asynchronous activity after the test ended`），但它在线上的表现就是一条静默的 unhandled rejection。
4. **构造不要求凭据，`check()` 在 `start()` 时才把话说死**。用户配置一个「还没填 secret」的机器人和配置一个能用的机器人，在启动期必须是同一种合法状态；缺 `appId`/`appSecret` 会报出字段名与 `CHANNEL_<ID>_APPID` 这个 env 变量名，且**不发起任何网络请求**。
5. **被动回复带 `replyTo`，群回群、私聊回人**。`replyTo` 就是入站帧的 `d.id`；群消息发 `/v2/groups/{group_openid}/messages`，私聊发 `/v2/users/{user_openid}/messages`。`conversationKey` 取 `group_openid`，私聊退到 `author.user_openid || author.id`。
6. **不做流式**。`project()` 收到 `token` 增量直接忽略，只在 `final`/`error` 发一条。宁可少一个体验，也不发一条「正在输入」然后被平台当成刷屏。
7. **错误分三类**：401 → `AUTH`（交给出站队列 invalidate 后重试一次），429/5xx → `RETRYABLE`，其它非 2xx → `PLATFORM`。QQ 的 4xx 里混着「msg_id 过期」「没权限发」等语义，一律不当可重试。

**实机证据**（真凭据 `appId=1906507317`、真网关 ws）：

- 换 token：`POST bots.qq.com/app/getAppAccessToken` → `{"access_token":"…","expires_in":"7142"}`。
- 网关：`GET api.sgroup.qq.com/gateway/bot` → `wss://api.sgroup.qq.com/websocket`，`shards=1`，`session_start_limit.total=1500`。
- Identify 后：`op 0 t READY s 1`，`d.user = {"id":"10880449181683288941","username":"alice","bot":true}`，`heartbeat_interval=41250`，`session_id` 形如 `f8398afb-…`。
- 用**驱动本身**（不是临时探针）跑 35s：`sessionId=f8398afb-…`，`stats={"connects":1,"disconnects":0,"heartbeats":0,"resumes":0,"reidentifies":0,"dispatches":0,"errors":0}`，`seq=1`。心跳计数为 0 是对的——间隔 41.25s，窗口只有 35s。
- `check()` 对真实配置返回 `[]`（无问题项）；构造期不碰网络，`start()` 才拨号。

断言：`channels/qq/qq.test.js` 18 条（契约 + `streaming=false`、`check()` 文案与 `start()` 拒绝且不联网、`QQBot` 头 + READY 解析、群 @ 一轮 + 被动回复带 `msg_id`、自身/bot/空文本被丢、断线后 op6 带 `session_id`+`seq`、token 过期重取、send 401→AUTH，以及按钮数据往返、`INTERACTION_CREATE` 只认 `type=11`、先 ack 后路由、群成员不能替他人审批、单选问题一次点击即解析）。

**通宵压测的结论（环境限制，不是驱动问题）**：后台守护进程在会话空闲约 10 分钟后被云主机回收——日志停在 `+601s` 的快照（`connects=1, heartbeats=14, errors=0, rssMb=69`），既没有 `stopped` 收尾行，也没有守护脚本的重启记录，属于进程被外部杀掉的形态。因此「token 过夜自动刷新」这条路径只能靠单测的注入时钟覆盖（`now()` 拨过 5080s 有效期），不能靠长时间驻留验证。

未校准（仍需实测）：被动回复的时限（官方只说「数分钟内」，具体值未查证）；`POST /v2/groups/{openid}/messages` 的返回体是否带新消息 id（当前实现不看返回体）；`msg_seq` 在同一事件上回多条时按 1..5 递增、第 6 条起省略 `msg_id` 走主动配额，平台是否如此计费未实测；附件发送仍未实现（`canAttachFiles` 只在能力位里声明）。

**端到端实机证据**（机器人 `alice` 已进真实群 `bot-test`）：

- 入站帧（**没有 @ 机器人**的普通群消息）：`{"t":"GROUP_MESSAGE_CREATE","d":{"id":"ROBOT1.0_ehzy9WJet.EdZg9E7WoWuSLNaCvFZiyRexnrA16m.D2hrtGlyMZdWK1WW2o.oyJKK9ehjS8aptC34GRHBA8nksWcH0kJro5L90MMgcfbEAE!","content":"第二次测试","group_openid":"36C3AE31DA7BBBAB85BC66FE4A2E0074","author":{"id":"FA66D4D278502A6E570C45E8BA4FB416"}}}`——这个群放开了「接收全部消息」，所以能拿到 `GROUP_MESSAGE_CREATE`；默认的 `GROUP_AT_MESSAGE_CREATE` 路径尚未在本群观察到。
- 驱动解析结果：`conversationKey=36C3AE31…0074`（群 `group_openid`）、`senderId=FA66D4D2…F416`（`author.id`）、`text="第二次测试"`、`mentioned=false`、`eventId === replyTo === "ROBOT1.0_…!"`。
- 被动回复：`echo: 第二次测试`，群里可见，`stats` 无 `errors`。`msg_id` 的形状是 `ROBOT1.0_<base64-ish>` 且**以 `!` 结尾**，长度远超普通的 32 位 id，任何按定长截断的实现都会把它弄坏。
- 踩坑记录：`id` 必须整串原样回填，不能 trim 掉尾部 `!`，也不能 URL 编码。第一版没有这个问题，但值得写下来。

未验证：`GROUP_AT_MESSAGE_CREATE`（默认模式）在本群的实机帧、以及 `msg_id` 被重放（同 id 再回一次）时平台的错误码。

### 消息按钮与交互回调

QQ 没有自由卡片，只有「Markdown 消息 + `keyboard`」：最多 5 行、每行最多 5 个按钮，按钮文案约 10 字。驱动把它收敛成三张固定卡：

- 审批：`允许一次` / `拒绝`，按钮数据 `qq:a:<id>:approve|deny`；
- 提问：单选且选项 ≤5 时每个选项一个按钮，`qq:q:<id>:<questionId>:<index>`；多选、无选项或超过 5 个选项转文本/Web；
- 计划审批：`批准` / `退回` / `我要修改`，`qq:p:<id>:approve|reject|edit`。

点击不是新消息，而是同一 socket 上的 `INTERACTION_CREATE`（`type=11`，Intent `1<<26`）。驱动必须先 `PUT /interactions/{id}` 回应（`code=0` 成功、`4` 无权限），再把结果交给 core 的 `InteractionService`。`channels/manager.js` 用 `interact` 与按钮事件 id 去重，且**不**把它塞进 turn 队列；`launcher.js` 只在 `capabilities.canPromptUser === true` 时把该通道的 turn 改成 `supervised`，否则仍 `autonomous` 自动拒绝。

投影时序也随之改变：`channels/inbound/pipeline.js` 不再等 turn 结束才批量投影，而是 emit 时立即入一条串行投影链。审批卡必须在 turn 等待点击时发出去，否则就是「turn 等按钮、按钮等 turn 结束」的死锁。

已知边界：群聊被动回复窗口约 5 分钟，超过后按钮消息发不出去，目前没有主动消息兜底；多问题里只要有一个不可按钮化，整批转 Web；计划「我要修改」和单条自由文本问题用下一条同会话同发送者的文本作为答案。

### 附件：唯一能进来的文件通道

先回答一个常被问的问题：**机器人能不能读群文件库？不能，给管理员权限也不能。** 官方接口索引里 QQ 群相关的全部端点只有群信息、群成员、入群申请、黑名单、禁言、发/撤回消息、富媒体上传 —— 没有任何「列群文件 / 下载群文件」的接口。管理员权限开放的是成员移除、审批、黑名单、禁言那一类，不产生文件能力。

能拿到文件的唯一入口是**聊天里的富媒体消息**：`MessageAttachment` 带 `url`（`https://multimedia.nt.qq.com.cn/download?appid=…&fileid=…&rkey=…&spec=0`）、`filename`、`size`、`content_type`、图片还有 `width`/`height`，语音额外给 `voice_wav_url`。`content_type` 是 MIME 或两个枚举字面量：`"file"`（群文件/普通文件）与 `"voice"`。

`events.js` 把这一层收敛成固定形状，下游不必知道平台字段名：

```
{ url, name, contentType, size, width, height, voiceUrl, kind }   // kind: image|video|voice|file|other|unknown
```

并且**附件消息不再因为「没有文字」被丢掉**：`text` 为空但有附件时照样进管道；`text` 和附件都空才是非消息。模型看不见 `attachments` 数组（提示词只吃 `messages`），所以每个附件在 `messages[0].content` 里补一行描述，**故意不放签名 URL**（很长、有时效、会喧宾夺主）：

```
[attachment] report.pdf (file, 1.0MB)
[attachment] p.jpg (image/jpeg 1920x1080, 250.0KB)
```

未实现/未验证：下载器（大小上限、类型白名单、不落盘到项目目录）、`rkey` 的具体有效期、`file` 附件是否真能免鉴权直下（云湖那套是「无鉴权只防 Referer」，QQ 大概率靠 `rkey` 自身签名，但没实测）。



### 14.1 UI 控制面

左栏配置组「🔌 通道」进入通道主视图页：左侧实例列表、右侧详情。列表与详情只展示 `manager.list()` 的全量快照，不读 `user/channels.json`；`enabled:false` 的实例不出现在 UI。

页面通过流式 RPC `channel.subscribe` 接收快照：订阅建立即推一份当前列表，之后每次状态变化推全量列表。启停走 `channel.start` / `channel.stop`，均需二次确认；操作按钮只在右侧详情区，失败时在详情顶部显示后端原文（含缺失凭据字段名与 `CHANNEL_<ID>_<FIELD>` 环境变量名）并 toast。当前权限预设不约束 UI 启停，确认就是边界。

推送断开后不自动重连、不轮询降级：页面顶部常驻提示并提供手动刷新（`channel.list`）。订阅在首次进入页面时建立，切页不取消；页面卸载时客户端取消订阅。UI 不写配置、不提供实例增删改，配置仍手工维护 `user/channels.json`（模板见 `channels/channels.example.json`）。

## 15 里程碑

| 阶段 | 交付 | 依赖凭据 |
|---|---|---|
| M1 | `contract.js`、`assertChannel`、`registry`、`fake/`、四项共享层骨架、测试 1–6 | 否 |
| M1.5 | 共享机制上提 `accounts/`；`proxies/` 契约与 `fake` 同期落地 | 否 |
| M2 | ✅ 已落地：`feishu/` 驱动 + 假平台全链路（19 条断言） | 真实群里验证仍需 appId/appSecret |
| M3 | 出站队列实测限流、卡片流式节流、`trust` 与权限门接线 | 需真实账号 |
| M4 | ✅ 已落地两轮：云湖（webhook/ws 双模）+ QQ 官方机器人（ws）；插槽验收通过 | 云湖、QQ 均为真凭据 |

M4 是插槽是否成立的唯一判据：**第二个驱动不应修改共享层任何一行**。

## 16 验收

- `node --test "test/accounts/**/*.test.js" "test/channels/**/*.test.js" "test/proxies/**/*.test.js"` 全绿。
- `pnpm graph` 零违规，三条规则在列：`accounts-is-shared`、`channels-no-core-internals`、`proxies-no-core-internals`。
- `arch.md` 的「插槽：账号接入」一节写明两类钥匙、四个角色与禁令。
- M2 验收以真实飞书群为场景：一条消息进去，卡片回复出来，中途断开重连不重复回复。

## 17 未定项

1. 飞书实例的 `trust` 默认值（`allowlist` 还是 `owner`）。
2. ~~QQ 走官方机器人还是 OneBot~~——已定：官方机器人 + WebSocket（Webhook 需公网与固定端口，本机不具备）。
3. 是否允许一个会话同时接两个 channel（跨渠道延续同一 session）——本设计默认**不允许**，如需再做。

[^yh-mode]: 控制台里这两个开关互斥，这也是我们一次误判的根源：驱动按 webhook 等消息，而机器人仍停在「服务器事件推送」，于是两边都以为对方在动。

[^qq-shared]: 共享 auth 的改动是三个可选参数与一种返回形状；云湖、飞书都没有传，测试 `accounts/auth/index.test.js` 6/6 与 220 条基线在改动前后一致。
[^qq-ws]: 官方文档原话：「WebSocket 不依赖公网服务器部署，适合个人单机使用」。Webhook 回调只允许 80/443/8080/8443 且需要签名校验。
