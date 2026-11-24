# 入站：让消息从飞书走进来

这份文档回答一个问题：到目前为止，我们这个 agent 只会「被叫」——模型拿代理的凭据往外发。入站要把方向反过来：外部平台的一条消息，能变成一次 turn，并把结果落回那个会话。

## 1 归属：入站只可能发生在「应用身份」，不在 proxy

这是本设计的第一条，也是最容易被绕错的一条。

`proxies/contract.js` 写着 proxy 没有入站，这不是没做完，而是**平台层面就没有**：飞书的事件（`im.message.receive_v1`）投递给**应用**，用应用凭据加签/加密，收件地址属于应用；用户身份（`user_access_token`）没有任何「订阅我收到的消息」的接口。所以「以我本人身份收消息」只有两种实现：要么走应用再映射到人，要么轮询 `im/v1/messages` 补齐——后者是拉取，不是推送，与这里的入站不是一件事。

由此本轮的落点是**通道层**：`channels/feishu` 一个机器人实例，凭据是 `appId`/`appSecret`（应用身份），与 `proxies/lark` 的 `me`（自然人代理）泾渭分明。同一台机器上两者并存不冲突：`me` 负责「以我身份做事」，`wing-bot` 负责「有事找我」。

## 2 协议：长连接，不是 webhook

| 方案 | 需要什么 | 在本环境的结论 |
| --- | --- | --- |
| webhook | 平台能访问到的公网 HTTPS 地址 | 云主机无公网入口；`cloudflared` 可以临时给一个域名，但地址每次可能变，且隧道进程会被回收——只能当备选，不能当默认 |
| 长连接（WS） | 应用凭据 + 出站到平台的 wss | **本轮采用**。出站方向本来就是我们已有能力，不需要任何入站端口 |

长连接的帧是 **protobuf**，不是 JSON，握手还要应用凭据，所以生产必须用官方 SDK 的 `WSClient`（`@larksuiteoapi/node-sdk`，已在依赖里）。`channels/feishu/transport.js` 那个纯 JSON 的 WebSocket 客户端是给假平台和夹具用的；两者通过 `deps.connect` 同一个签名替换，驱动本身不感知差异。这也是为什么 `sdk-connect.js` 存在：它负责把 SDK 压平后的 payload 还原成 `{ schema, header, event }` 信封。

## 3 契约：复用通道槽，不新开槽

入站已经是 `channels/` 槽的既有形状，本轮不改契约：

- `capabilities`：`eventMode:"ws"`、`ackDeadlineMs:3000`、`streaming:true`、`canAttachFiles:true`、`canPromptUser:false`。
- `check()`：起连接前才检查 `appId`/`appSecret`（缺失就拒绝启动，而不是启动一半）。
- `start(onMessage)` / `project(message, event)` / `stop()`。

`ackDeadlineMs:3000` 是平台约束，不是建议：飞书要求事件回调 3 秒内应答，而一次 turn 量级是分钟。所以 `start` 的 `onMessage` **必须立刻返回**，turn 在 `channels/inbound/pipeline.js` 的队列里跑，而不是在回调里 await。

## 4 一条消息的处理链

```
WS 帧
  → sdk-connect.toEnvelope          还原信封
  → events.parseEvent               非 im.message.receive_v1 / 自己发的 / 无文本 → 丢弃
  → pipeline.handle                 立即返回（ack）
      → dedupe.claim(event_id)      event_id 见过就丢（落盘 24h，跨重启有效）
      → 会话串行队列(每 conversation 1 条在飞)
      → sink.runTurn(message, emit) 一次普通 agent turn
      → channel.project(message, …) 卡片：首 token 建卡，之后节流 patch，终端事件收尾
```

三个刻意的选择：

1. **去重按 `event_id`，且落盘**。平台在没收到 ack、超时重投、连接抖动时都会重发同一条事件；重跑的代价是双倍 token 和双倍写入。落盘（`data/channels/dedupe-<instance>.json`）让「重启之后的重投」也还是重复。
2. **同一会话串行**。并发跑同一会话的两个 turn，回复会互相覆盖，且平台重试本身就是「同一条被投两次」，串行是唯一不打架的顺序。
3. **回复用一张可 patch 的卡片**。平台对消息更新有频率限制，所以 patch 按 `throttleMs`（默认 250ms）节流；终端事件（`turn-end`/`done`/`error`）无论节流与否都要落最终状态——沉默会被读成「机器人挂了」。

## 5 群的边界（第一版）

`parseEvent` 目前接受**任何用户发的文本消息**，群里也一样。第一版有意如此：先用最简单规则证明链路。已知代价是群里任何一句话都会触发一次 turn。第二版会加「群里只处理 @ 机器人」的判断——这需要读 `message.mentions`，并且要区分「@所有人」，留到下一轮。

## 6 控制台清单（一次性）

应用 `cli_ab8977fc47f89d1c`（Personal Edition）：

1. **添加应用能力 → 机器人**。
2. **权限管理**加：`im:message.p2p_msg:readonly`（读用户发给机器人的单聊消息）、`im:message.group_msg`（群里 @ 机器人的消息需要它，视租户而定）、`im:message:send_as_bot`（以机器人身份发消息/卡片）。
3. **事件与回调 → 订阅方式选「长连接」**，添加事件 `im.message.receive_v1`。
4. **版本管理与发布**：创建版本 → 发布（Personal Edition 免审即时生效）。

这四步缺一步的表现都不一样，排错顺序按「先凭据（`check()` 拒启）→ 再事件（连上但收不到）→ 再权限（收到但发不出）」。

### 6.1 实际配置结果（2026-11-23）

- 机器人能力已添加；应用版本 **1.0.1** 已发布（首页显示「当前修改均已发布」）。
- 应用身份权限 3 项均「已开通」：`im:message`、`im:message:send_as_bot`、`im:message.p2p_msg:readonly`。第 2 步里的 `im:message.group_msg` 暂未申请——第一版只验证单聊，群消息要等「群里只处理 @」那版。
- 事件订阅方式 = **长连接**，事件 `im.message.receive_v1`（应用身份，所需权限显示「已开通」）。
- 另加一项**用户身份**权限 `im:message.send_as_user`，动机见 6.2，结论是它也没法用来私聊机器人。

### 6.2 一个平台事实：人不能通过 API 主动私聊机器人

想不靠人操作就触发一次入站，直觉做法是用用户身份给机器人的 `open_id` 发消息。实测**走不通**：

| 尝试 | 结果 |
| --- | --- |
| 旧应用 user 身份 → 机器人 `open_id` | `99992361`，跨应用不认识 |
| 同应用 user 身份 → 机器人 `open_id` | `230027`，缺 `im:message.send_as_user` |
| 补上 `im:message.send_as_user` 再发 | `230001`：`this operation to bots is currently not supported` |

也就是说「用户给机器人发消息」只发生在飞书客户端里。可自动化的只有反方向：机器人用应用身份先给用户发一条（`receive_id_type=open_id`），把 p2p 会话建出来并拿到 `chat_id`，人再在那条会话里回一句，事件才通过长连接推过来。验证的步骤因此固定为「建会话 → 人回一句 → 看运行器日志与卡片」。


## 7 运行与回收

云主机的后台进程在会话空闲约 10 分钟后会被回收，所以入站不能指望「起一次就长期在线」。本轮的运行器是仓库根目录的 `channel-run.js`（入口层，和 `launcher.js` 同级，因此允许组装 core/channels）：

- 前台 `node channel-run.js --channel wing-bot`，打印每次投递/去重/turn/投影；
- `--echo` 模式不接模型，直接把收到的话回显成卡片，用来单独验证「链路通不通」；
- 默认模式把 turn 接到 `core.agent.chat`（与 launcher 的 sink 一致）；
- `npm run channel -- --channel wing-bot` 是同一件事。

要长期在线，需要外部保活（真正的部署另说），本轮的验收标准是「一个会话时长内，消息能进来、能出去、重启后重投不重跑」。

## 8 本轮里程碑

| 编号 | 内容 | 验收 |
| --- | --- | --- |
| M18-A | 长连接收到真消息 → 去重 → 回显卡片 | 真机私聊一条，卡片落回同一会话；同一 `event_id` 重投不产生第二张卡 |
| M18-B | 同一链路接到 `core.agent.chat`（mock provider） | 回复内容来自模型而非回显 |
| 后续 | 群里只处理 @、卡片交互（按钮/表单）、webhook 备选 | — |

### 8.1 首条真机消息：一半成功，一半踩到限流

2026-11-23 06:13（UTC）在客户端回了一句「嘻嘻」，事件真的从长连接进来了：`[echo] oc_ee7c... f876fd18...: 嘻嘻`，`chat_id` 与机器人先发消息的会话一致，`turns=1`。但紧接着回卡片时平台返回 `230429 This operation triggers the frequency limit`。

关键点是这个限流**用 HTTP 200 返回**（`code=230429`），只看 status 会被判成「平台拒绝、不重试」，卡片就直接丢了。修复：`accounts/errors.js` 增加`isThrottleCode`（230429 / 99991400 / 11232）→ 归入 retryable，`channels/feishu/api.js` 用它给 `ChannelError` 定性，交给 outbound 队列退避重试；假平台加了 `throttleNext` 开关，新增一条「限流后被重试、卡片仍只落一次」的测试（327 全绿）。

同一现象第二次出现时错误变了：`feishu http 504`（三次重试后仍失败）。这一层的锅不在飞书，而在云主机的出口代理——`HTTP(S)_PROXY` 指向一个 hijack 代理，它偶尔直接把请求答成 `504 hijack proxy request failed`，而 Node 的全局 `fetch` 默认不理会 `NO_PROXY`（实测同一段代码连发三条，第一条 504、后两条 200）。

修法：新加 `lib/net/direct-fetch.js`（node:https 实现、显式 Content-Length、绕过代理环境），运行器把它作为 `deps.fetch` 注入，token 与消息调用都走直连；顺带发现飞书 token 端点对 chunked 体内的请求回 `invalid param`，所以必带 `Content-Length`。注入后离线投影一张卡片到真机会话：`card ok`（`om_x100b7f09d778fca4-…` 那条文本探测与这张卡都在会话里可见）。

修完代理之后又暴露了第三层问题：模型模式的第一条消息回来了，但卡片上写的是 `session not found: ch:feishu:wing-bot:oc_…`。原因很直接——**core 的 session id 是 store 里的数字行，不是平台会话串**；把 `ch:feishu:…` 直接当 sessionId 传进去，registry 去 sessions 表里按数字查，自然查不到。

修法：新增 `channels/inbound/sessions.js`（对话绑定），把「平台会话键 → session 行 id」记住并落盘（`data/channels/sessions-*.json`），首次遇到某会话时用 `session.create` 建行；`sessions.workspace_id` 是 NOT NULL，所以没有 workspace 时先建一个。入口层（`launcher.js` 与 `channel-run.js`）的 sink 都先 `resolve` 再 `agent.chat`，两条路径口径一致。4 条绑定测试（复用 / 双会话 / 被外部删除后重建 / 重启后仍复用），331 全绿。

第四层：绑定好了、turn 也 `succeeded`，但客户端什么也没有——**投影器读错了字段**。core 的流式事件是 `{ type: "token", delta }`（`docs/runtime/model-call.md` §4.1），投影器读的是 `event.content`，累积文本永远是空串，而「没有内容就先不发卡」这条保护把整轮吞掉了。改成读 `delta`（兼容旧 `content`），并在 `done` 带 `message.content` 时兜底非流式场景；两条投影测试补上，333 全绿。

至此真机闭环成立：客户端一条「介绍一下豆包」→ 长连接收到 → 去重 → 会话串行 → core turn（mock provider）→ 卡片以同一 `chat_id` 落回，卡片文本正常显示（人已确认）。四层问题（限流码、出口代理 504、session 绑定、投影字段）都留了测试或断言，`channel-run.js` 的 `--echo` 仍可用于不接模型的单独回归。

## 9 不在本轮

- `watchers/` 之类的「以人身份入站」新槽：平台没有对应能力，先不造抽象。
- 附件与图片消息解析（`parseEvent` 目前只取文本；`file_key`/`image_key` 需要下载才能用）。
- 消息撤回/编辑事件（`im.message.recalled_v1` 等）。
- 多实例负载均衡：一台机器一个连接，重复连接平台会当成两个客户端，manager 已明确拒绝二次 `start`。
