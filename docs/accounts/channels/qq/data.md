# QQ 机器人 channel 数据结构

收/发两侧的完整字段清单。入站从平台原始帧到中性 `InboundMessage`，出站从驱动调用入参到 HTTP body，末尾给出两者的字段对接关系。所有字段按当前源码对齐。

## 入站消息

### 平台原始帧

原始帧只在 gateway 内部存活，解析后不向共享层传递。

```ts
// 消息 dispatch — gateway.js:107
{
  op: 0,
  t: "GROUP_AT_MESSAGE_CREATE" | "GROUP_MESSAGE_CREATE" | "C2C_MESSAGE_CREATE",
  s: number,
  d: {
    id: string,
    content: string,
    author: { id?: string, user_openid?: string, member_openid?: string, bot?: boolean },
    group_openid?: string,
    attachments?: Array<{
      url: string, content_type?: string, filename?: string,
      size?: number, width?: number, height?: number, voice_wav_url?: string
    }>
  }
}

// 按钮 dispatch — events.js:128
{
  op: 0,
  t: "INTERACTION_CREATE",
  s: number,
  d: {
    id: string,
    type: 11,
    group_openid?: string,
    user_openid?: string,
    group_member_openid?: string,
    scene?: string,
    data: { resolved: { button_data: string, button_id?: string } }
  }
}
```

### 中性入站消息

`events.js:42-59` 的产出，是进入共享管道的标准形状。

```ts
{
  type: string,              // "qq"，来自 context
  instanceId: string,        // 来自 context
  conversationKey: string,   // group_openid || author.user_openid || author.id
  eventId: string,           // d.id
  senderId: string,          // author.member_openid || author.id || author.user_openid
  recvType: "group" | "user",// 有 group_openid 即 group
  replyTo: string,           // d.id，出站 msg_id 的来源
  mentioned: boolean,        // frame.t === "GROUP_AT_MESSAGE_CREATE"
  messages: [{ role: "user", content: string }],
  attachments: Attachment[],
  raw: {
    event: string,
    id: string,
    groupOpenId: string,
    senderId: string
  }
}
```

`messages[].content` 由 `[text, ...attachments.map(describeAttachment)].filter(Boolean).join("\n")` 拼成（`events.js:56`）：正文在前，每个附件一行描述。签名 URL 不进入提示词，只保留在 `attachments[].url`。

`mentioned` 来自事件类型而非正文判断——QQ 的 @ 事件里 `content` 已剥离 mention 标记。

消息进入 `pipeline.js:63` 后附加 `sessionId` 字段，值为 `ch:qq:<instanceId>:<conversationKey>`（`session-namespace.js:23`）。

### 附件

`events.js:67-84` 的归一结果。

```ts
{
  url: string,       // 平台签名下载地址；a.url 不存在的条目被过滤
  name: string,      // a.filename || 按 kind 生成
  contentType: string, // a.content_type 原样，可能是 MIME 或 "file" / "voice"
  size: number,
  width: number,
  height: number,
  voiceUrl: string,  // a.voice_wav_url，语音的转码 WAV
  kind: "file" | "voice" | "image" | "video" | "other" | "unknown"
}
```

`kind` 的判定（`events.js:87-94`）：`"file"`、`"voice"`、`image/*`、`video/*`，其余非空值归 `other`，空值归 `unknown`。描述文本形如 `[attachment] <name> (<type>< WxH><, size>)`（`events.js:110-115`）。

### 按钮交互

平台解析产物 `Interaction`（`events.js:141-153`）：

```ts
{
  type: string,
  instanceId: string,
  conversationKey: string,  // group_openid || user_openid
  eventId: string,          // d.id
  interactionId: string,    // d.id，ack 使用此 id
  buttonId: string,         // resolved.button_id
  buttonData: string,       // resolved.button_data，形如 "qq:a:12:approve"
  senderId: string,         // group_member_openid || user_openid
  recvType: "group" | "user",
  scene: string,
  raw: { event: string, id: string, groupOpenId: string, senderId: string }
}
```

按钮载荷解码 `ButtonData`（`cards.js:120-152`）：

```ts
{ kind: "approval",    id: number, decision: "approve" | "deny" }
{ kind: "question",    id: number, questionId: string, index: number }
{ kind: "plan-review", id: number, action: "approve" | "reject" | "edit" }
```

回灌 core 的交互对象（`index.js:165-228`、`index.js:242-263`）：

```ts
{ kind: "approval", id, decision, conversationKey, senderId, eventId }
{
  kind: "question", id, conversationKey, senderId, eventId,
  answers: [{ id: string, selected: string[], custom?: string }]
}
{ kind: "plan-review", id, approved: boolean, feedback: string, conversationKey, senderId, eventId }
```

`answers` 有两种来源：按钮点击写入 `selected: [option.label]`（`index.js:185`）；文本续答写入 `selected: [], custom: text`（`index.js:259`）。

## 出站消息

### 调用入参

`api.js:125-142` 定义的形状，由 `sendText`、`sendCard` 和 `project()` 的终态分支构造。

```ts
{
  groupOpenId?: string,   // 群目标
  userOpenId?: string,    // 私聊目标
  content?: string,       // 纯文本兜底，群发要求携带
  msgId?: string,         // = inbound.replyTo，被动回复凭据
  eventId?: string,
  msgType?: number,       // 默认 0，卡片为 2
  msgSeq?: number,        // 同一 msgId 的回复序号
  markdown?: { content: string },
  keyboard?: { content: { rows: Array<{ buttons: Button[] }> } } | null
}
```

`groupOpenId` 与 `userOpenId` 至少有一个，否则 `api.js:144` 抛错。目标由 `targetFor()` 决定（`index.js:87-91`）：`recvType === "group"` 时 `groupOpenId = conversationKey`，否则 `userOpenId = senderId`。

### HTTP body

`api.js:143-154` 实际发出的请求。

```ts
POST /v2/groups/{groupOpenId}/messages
POST /v2/users/{userOpenId}/messages

{
  msg_type: number,
  content?: string,    // !== undefined 时写入
  markdown?: object,   // !== undefined 时写入
  keyboard?: object,   // !== undefined 时写入
  msg_id?: string,     // msgId 真值时写入
  event_id?: string,   // eventId 真值时写入
  msg_seq?: number     // Number.isInteger(msgSeq) 时写入
}
```

### 键盘与按钮

`cards.js:19-38` 的构造，用于 Markdown 消息底部的可点击区域。

```ts
Button = {
  id: string,
  render_data: {
    label: string,         // 截断到 10 字符
    visited_label: string, // 截断到 10 字符
    style: number          // 默认 1
  },
  action: {
    type: 1,               // 回调型
    permission: { type: 2 }, // 所有人可点，身份校验在驱动侧
    data: string,          // "qq:a|q|p:<id>:..."，ButtonData 的编码
    unsupport_tips: string
  }
}

keyboard = { content: { rows: Array<{ buttons: Button[] }> } }
Card = { text: string, keyboard: keyboard | null }
```

键盘最多 5 行、每行最多 5 个按钮，按钮文案约 10 字，超出部分截去并以省略号收尾（`cards.js:13-17`）。

三种卡的 `text` 与按钮 data（`cards.js:51-109`）：

| 卡 | text | 按钮 data |
|---|---|---|
| 审批 | 工具名 + 参数摘要 + 权限 | `qq:a:<id>:approve` / `qq:a:<id>:deny` |
| 提问 | header + question + 编号选项列表 | `qq:q:<id>:<questionId>:<index>` |
| 计划 | 标题 + plan（截到 1800 字） | `qq:p:<id>:approve` / `reject` / `edit` |

### 三种出站调用形态

```ts
// sendText — index.js:123-126
{ ...target, content: text, msgId, msgSeq }

// sendCard — index.js:110-120
{
  ...target,
  content: card.text,
  msgType: 2,
  markdown: { content: card.text },
  keyboard: card.keyboard,
  msgId, msgSeq
}

// final 分支 — index.js:414-420
{ ...target, content: text, msgId: reply.msgId, msgSeq: reply.msgSeq }
```

`msgId` 与 `msgSeq` 来自 `replyFields()`（`index.js:100-108`）：`key = replyTo || eventId || conversationKey`，`seq = replySeq.get(key) + 1`；`seq <= 5` 时携带 `msgId = message.replyTo` 和 `msgSeq`，否则两者为 `undefined`。`final` 分支发出后删除该 key（`index.js:421`）。

### 按钮确认

`api.js:165-168`，不是消息投递，是对平台的一次性确认。

```ts
PUT /interactions/{encodeURIComponent(interactionId)}
{ code: number }
```

`code` 取值：`0` 成功、`1` 失败、`2` 太频繁、`3` 重复、`4` 无权限。

## 字段对接关系

| 入站字段 | 出站去向 | 规则 |
|---|---|---|
| `replyTo`（= `d.id`） | `msgId` → body `msg_id` | 前 5 次回复携带，超出省略 |
| `replySeq` 计数 | `msgSeq` → body `msg_seq` | 同一入站消息递增，平台拒绝重复的 `msg_id` + `msg_seq` 组合 |
| `conversationKey` | 群 `groupOpenId` | `recvType === "group"` 时 |
| `senderId` | 私聊 `userOpenId` | `recvType !== "group"` 时 |
| `eventId` | 可选 body `event_id` | 仅按钮触发的文本提示使用（`index.js:214`） |
| `pendingActors` 的 `id` | 按钮 `data` 中的 id | `project()` 收到 core 事件时写入，`handleInteraction()` 查表 |
