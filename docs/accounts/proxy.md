# proxy 插槽设计

> 本文件是设计规划，不含实现代码。
> 现状：M1.5 已落地契约（`proxies/contract.js`）、注册表、`fake` 驱动与断言；M3 已落地 `lark` 的 `cli` 与 `oauth` 两条路线（31 条断言）、`accounts/auth` 的 `oauthRefresh` 策略，以及首授权引导 `scripts/oauth-consent.js`（10 条断言）。
> 配套：共享基础见 `accounts.md`，机器人账号见 `channel.md`。

## 1 定义

**proxy 是一个已认证的自然人账号授权**：用这个人的钥匙（`user_access_token`，或本地已登录的 CLI 会话）代替他执行动作——读文档、写表格、查日程、以本人身份发消息。

与 channel 的判据只有一条：**谁的身份在执行**。机器人身份 → channel；自然人身份 → proxy。

proxy 没有入站事件，也不常驻。它被调用一次、做一件事、返回结果。因此契约里没有 `ackDeadlineMs`、没有 `start`/`project`，也不做事件投影。

## 2 契约

```js
/**
 * @typedef {Object} Proxy
 * @property {string} type
 * @property {string} instanceId
 * @property {() => Promise<string>} whoami    // 这条授权代表谁
 * @property {string[]} scopes                 // 已授予的 scope，模型可见的能力边界
 * @property {(action: string, params: Object) => Promise<Object>} call
 * @property {{headers: Function, invalidate: Function}} auth  // 复用 accounts/auth
 */
```

`assertProxy` 校验字段齐备、`scopes` 必须是非空字符串数组、`auth` 具备 `headers`/`invalidate`。`hasScope(proxy, scope)` 是驱动在动手前做的最小权限校验。

凭据、错误分类、出站节奏、实例发现全部来自 `accounts/`，驱动里不出现 token 刷新代码。

## 3 配置

`user/proxies.json`：

```jsonc
{
  "proxies": [
    {
      "id": "me",
      "type": "lark",
      "enabled": false,
      "scopes": ["doc:read", "doc:write", "drive:read"],
      "credentials": { "clientId": "cli_xxx", "clientSecret": "xxx" },
      "options": { "impl": "oauth" }   // oauth | cli
    }
  ]
}
```

`scopes` 是授权范围的唯一真源，也是模型侧的能力边界：没授予的动作在驱动里直接拒绝，不产生网络请求。

## 4 权限与归属

- 动作分级：**读 allow、写 ask、删除与共享 deny**。proxy 动的是本人账号与数据，出事的责任归属是本人，不是机器人。
- 归属标识：每次调用记录 `on behalf of <whoami>`。这是事后唯一能证明「这是代办，不是本人操作」的东西。
- 凭据边界同 channel：只在 `user/`，不进日志、不进 `data/store.db`。

## 5 两条实现路线

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| `oauth` 直连 API | 授权 URL → code → `user_access_token` + `refresh_token`，401 走 `oauthRefresh` | 可部署、可换机器、scope 由平台强制 | 需要同意授权流程与回调；多一套 token 生命周期 |
| `cli` 包装 | `call()` 变成调子进程（如 `lark-cli`） | 开发期立刻能跑，不必配 OAuth | 授权状态绑在那台机器的本地登录上，换机器即断 |

建议先落 `cli` 跑通链路，再换 `oauth`：契约按行为定义（`whoami` / `scopes` / `call`），换实现不影响调用方。

两条路线现已都落地。`options.impl` 是唯一的切换点；动作表、scope 门、risk 门由 `gate.js` 共用，所以两条路线允许做的事**完全一致**——换路线不会顺带扩权。

## 6 模型侧怎么用

不做「一个 API 一个工具」。飞书的文档、表格、日历、消息加起来几十个接口，全做成 tool 会撑爆工具列表。

做法：`tools/lark/run.js` 只做薄壳，接 `action` + `params`，经 `exec.capabilities.proxy(id)` 取到 proxy 再 `call`。这样 `tools-only-via-capabilities` 规则一行不用改——proxy 从既有的 capabilities 口子进去，而不是在 tools 里新增一条硬依赖。

薄壳的三条约定：

1. **动作是闭合集合**：`whoami` / `list_proxies` / `doc.read` / `drive.list` / `api`，写死在 registry 的 `enum` 里。新增动作必须改 `proxies/lark/actions.js`（那里同时声明 scope 与 risk），不做「传个 URL 就能调」的开放面。
2. **proxy 必须显式或唯一**：只配一个实例时可省略 `proxy`；配多个时必须点名，猜错等于以错误的人的身份写数据。`list_proxies` 只回元数据（id/type/scopes），不碰账号。
3. **能力缺席就报错**：没有 `exec.capabilities` 的 run（例如未装配插槽的 flow）直接拒绝，不伪造结果。

装配链条（谁 import 谁）：

- `launcher.js` 调 `createProxies()` 装配实例，作为值传给 `createCore({ proxies })`；
- `core/capabilities.js` 把实例包成 `exec.capabilities`（按 `instanceId` 查，不看顺序）；
- 三个 `runTool` 调用点（node-graph 的 tool-execute、linear、flow）都把 `capabilities` 放进 `exec`；
- `tools/lark` 只拿到「这次运行实际有哪些 proxy」，看不到 `proxies/` 目录本身——所以 `tools-no-core-internals` 等规则不需要为它开例外。

还有一层与项目无关的门：`user/permissions.json`。`lark` 未登记时默认 `ask`，即每次调用都会先问用户；想放行就显式写 `allow`。

## 7 现状

| 部分 | 状态 |
|---|---|
| `proxies/contract.js`、`assertProxy`、`hasScope` | 已落地 |
| `proxies/registry.js`（类型发现 + 实例装配 + 环境变量凭据） | 已落地 |
| `proxies/fake/`（scope 校验、凭据失效注入） | 已落地 |
| `proxies/lark/` 的 `cli` 实现（`whoami`、`doc.read`、`drive.list`、`api` 逃逸口） | 已落地（M3） |
| `proxies/lark/` 的 `oauth` 实现（同一动作表，HTTP 直连） | 已落地（M3） |
| `accounts/auth` 的 `oauthRefresh` 策略（单飞刷新 + 轮换持久化） | 已落地（M3） |
| 模型侧薄壳 `tools/lark/` + `exec.capabilities` 装配 | 已落地（M3） |
| 首授权引导（一次同意 → refresh token） | 已落地（M3）：`scripts/oauth-consent.js` |
| 写动作（`sheet.write` / `doc.create` / `doc.append`） | 已落地（M5）：两条路线同表，risk=write |
| 改文档内容（`doc.write`：replace / overwrite） | 已落地（M6）：cli 路线，replace=write、overwrite=high |
| 多区域写表（`sheet.write` 的 `writes`） | 已落地（M7）：cli 走 `--writes`，一次批量请求 |
| 删除（`drive.delete`） | 已落地（M7）：risk 恒 high，一次调用可删多份，逐份回报 |
| 文档块结构（`doc.blocks`）与块级改（replace/insert/delete） | 已落地（M8）：读两路线通，块写 cli 通 |
| 以本人身份发消息（`im.send`） | 已落地（M8）：text/markdown，真机发给自己 |
| 文件上传与导出（`drive.upload` / `drive.export`） | 已落地（M8）：路径被限制在 fileRoot 内 |
| 二进制/大文件分段读（`drive.read` 的 offset/limit/encoding） | 已落地（M9）：cli 下载缓存后本地 seek，oauth 内存切片 |
| IM 读侧（`im.chats` / `im.messages` / `im.search`） | 已落地（M10）：读群、读消息、搜消息，两条路线同表 |
| 找文件（`drive.search`） | 已落地（M11）：按内容/人/文件夹找，不用逐层翻目录 |
| 块语义上 oauth（`doc.write` 五种 mode 走 `docs_ai` 端点） | 已落地（M12）：两条路线同一份映射，真 oauth 链路实测 |
| 话题内回复读取（`im.messages` 的 `thread`/`threadId`） | 已落地（M12）：消息 id 先解析成 thread id |
| 话题内回复（`im.send` 的 `replyTo` / `inThread`） | 已落地（M13）：两条路线同一枚端点，真机回自己私聊成功 |
| 搜索限定（`drive.search` 的 spaceIds / chatIds / 四个人 / 四组时间窗） | 已落地（M13）：wiki-only 时只发 `wiki_filter`，绝对时间与相对时间同一套解析 |
| 非文本消息（`im.send` 的 image / file / audio / video） | 已落地（M14）：两路线各四发真机通过，语音限 Opus，视频必须带封面 |
| 通讯录解析（`contact.resolve`） | 已落地（M15）：名字 → `open_id` + `p2p_chat_id`，两条路线真机命中自己（scope 为 `contact:user:search`） |
| 日历（`calendar.agenda` / `calendar.create` / `calendar.delete`） | 已落地（M15）：读窗口、建（含邀请）、删（risk 恒 high），cli 与 oauth 两条路线均真机跑通 |
| 归属审计落库（`on behalf of` 记到哪） | 待做：目前只在调用元数据里带 proxy id |

### 7.1 cli 实现的实测事实

这些是跑真 CLI 得出的，不是从文档抄的：

1. **`lark-cli` 失败也返回退出码 0**。失败信息在 stdout 的 `{"ok":false,"error":{"subtype","code","message"}}`；实测请求一个不存在的路径，退出码仍是 0。所以 `runner.js` 只认 JSON，不认退出码——否则「403 无权限」会被当成成功。
2. **输出带 `identity` 字段**（`user` 或 `tenant`）。proxy 要求必须是 `user`：`tenant` 会话一律拒绝，否则就是机器人冒充自然人。
3. **`--dry-run` 可用**，返回 `{method, url, params}` 而不发请求，是验证命令映射最省事的办法。
4. **命令映射**：`doc.read` → `docs +fetch --doc <token> --doc-format markdown`；`sheet.read` → `sheets +csv-get --spreadsheet-token <t> (--sheet-name|--sheet-id) [--range A1:F30] [--max-chars N]`；`sheet.info` → `sheets +workbook-info --spreadsheet-token <t>`；`drive.list` → `api GET /open-apis/drive/v1/files --params {page_size[, folder_token][, page_token]}`（page_size 上限 200）；`drive.read` → `drive +fetch --token <token> --type file --embed-max-rows N`。
5. **两道门在起子进程之前**：先查 scope，再查 risk，被拒的动作没有任何副作用。默认 `allow: ["read"]`；`api` 逃逸口默认关闭（需 `allowApi: true`），风险按方法分级：GET/HEAD 读、POST/PATCH/PUT 写、DELETE high。
6. **CLI 会话刷新不了**。`auth.invalidate()` 是空操作：凭据在 CLI 自己的登录态里，换机器就要重新登录。这不是缺陷而是选型代价，也正是 `oauth` 路线存在的理由。
7. 每次 `call()` 一个子进程，默认 `qps: 1`、`maxAttempts: 2`，且**不接 auth 重试**（CLI 场景重试等于重复失败）。
8. **CLI 输出是「已剥掉 `data` 信封」的**：根目录列表回来的是 `{files:[…], has_more:false}`，不是 `{code,data:{files}}`。所以消费端要 `payload.files || payload.data?.files` 两路都认；只认一路的实现会静默拿到空列表（本轮就踩了一次，列表看着是 0 项而文件其实在）。
9. **平台业务码不能当 HTTP 状态码判**。`docs +fetch` 读一个 `.md` 文件返回 `code: 3380002`（"Only docx is supported"），第一版按 `status >= 500 → 可重试` 把它判成 RETRYABLE，等于对一个永久性拒绝反复重试。现已收敛：只有 100–599 的数字才按 HTTP 语义解释。

### 7.2 oauth 实现的实测事实

1. **token 端点存在且可用**：`POST /open-apis/authen/v2/oauth/token`。实测错误授权的 code 返回 `HTTP 400 {"error":"invalid_grant","code":20003}`，失效的 refresh token 返回 `code:20026`。所以成功判定**不能看 `code === 0`**（那是普通 API 的信封），要看响应里有没有 `access_token`。
2. **refresh token 每次成功刷新都会轮换**，而刷新响应只带两个 token 与其寿命，所以落盘是**合并写**而不是覆盖写：清掉 scope 等于把「我到底被批了哪些权限」这条唯一的本地记录扔掉。实测：把 `expiresAt` 改成过期值后跑一次 `calendar.agenda`，access/refresh 两个 token 都轮换，文件里的 `scope`（15 项）、`tokenType`、`obtainedAt` 原样保留。轮换后不落盘，下次启动拿的就是平台已作废的旧 token——所以 `onTokens` 是必需钩子。落点是 `user/oauth/<id>.json`（0600），配置文件里的 refresh token 只当首次引导用，文件更新时以文件为准。
3. **刷新必须单飞**。三个并发调用同时发现 access token 过期，如果各自刷新就会把 refresh token 轮换三次，只有最后一个有效。实测断言：三个 `headers()` 并发 → 端点只被调一次，三方拿到的都是新 token。
4. **401 能自愈**：队列收到 401 调 `auth.invalidate()`（只丢 access token，保留 refresh token）→ 重新刷新 → 原调用重试一次。实测记录里第一次请求 `authorized=false`，第二次 `authorized=true`。
5. **两条路线共用同一张动作表**：`doc.read` / `drive.list` 的 CLI 参数与 HTTP 映射写在 `actions.js` 同一个条目里，scope 与 risk 由 `gate.js` 统一判定，所以 oauth 不可能悄悄比 cli 多做一件事。
6. `sheet.read` 的 `token` 接受表格 URL（取最后一个路径段），`sheet` 与 `sheetId` **必须二选一**（两样都缺在起子进程之前就拒绝），`range` 省略即整张表（CLI 会自己裁剪到实际网格），`maxChars` 默认 12 万、上限 100 万——超过就由 CLI 截断并回 `has_more`。
7. `doc.read` 的 `doc` 既接受裸 token 也接受文档 URL（取最后一个路径段）；`drive.list` 的 page_size 上限 200，且新增 `folder`（接受裸 token 或 `/drive/folder/<token>` URL）与 `pageToken`；`drive.read` 的 `token` 同样是 token 或 URL；`api` 的 path 必须落在 `/open-apis/` 之下。
8. **oauth 路线上的 `drive.read` 只能读文本**：走 `GET /open-apis/drive/v1/files/<token>/download`，按 UTF-8 严格解码，>256KB 或解码失败（真二进制）直接报 `PLATFORM` 错误，并说明「cli 路线可做转换」。不做「把二进制塞给模型」这种假装成功的事。

### 7.3 首授权引导的实测事实

刷新链只能从「已经存在的 refresh token」开始。第一个 refresh token 必须由人点一次同意，所以那一步做成了一次性本地脚本（`node scripts/oauth-consent.js --instance me-oauth`），不是能自动化的流程。

1. **授权页是 v1，token 端点是 v2**。实测 `GET https://accounts.feishu.cn/open-apis/authen/v1/authorize` 返回 200 的登录页，而 `.../authen/v2/authorize` 在 `accounts.feishu.cn` 和 `open.feishu.cn` 上都返回 `404 page not found`——尽管 `.../authen/v2/oauth/token` 是通的。所以授权链接走 v1 路径，换 token 走 v2 路径，两个版本不能互推。
2. **`offline_access` 决定 refresh token 有没有**。授权时只带数据权限，换取 token 会成功但响应里没有 `refresh_token`；这时 oauth 路线立刻退化成一次性 token，看上去一切正常。脚本所以把 `offline_access` 强制拼进 scope，并且在「拿到的 token 没有 refresh_token」时打印警告并以退出码 1 结束，而不是报告成功。
3. **`scope` 是空格分隔**，需要 URL 编码；`redirect_uri` 必须先在开发者后台「安全设置 → 重定向 URL」里登记，否则平台不会跳回来。脚本第一行就打印实际使用的 `redirect_uri`，方便照抄去登记。
4. **回调只绑 `127.0.0.1`**，且必须比对 `state`。code 是凭据，监听在 `0.0.0.0` 等于把它暴露给同网段；不校验 state 则本机任意页面都能塞一个自己的 code 进来。
5. **脚本不打印 token 值**，只打印 scope、过期时间、token 文件路径（`user/oauth/<id>.json`，0600）。终端滚动记录不适合放 refresh token。

## 8 未定项

1. `scopes` 的命名与粒度是否直接照抄平台（`doc:read`）还是映射成本项目的动词表。
2. 归属审计落库位置：`data/store.db` 新表，还是只写日志文件。前者可查询，后者不碰 schema。
3. 是否允许多个 proxy 实例指向同一自然人（例如同时有 `oauth` 与 `cli` 两条通道）。

### 7.4 云盘浏览与「读自己的 .md」：本轮补的两件事

起因是实测里连着卡了两次：`drive.list` 只能看根目录，`doc.read` 读不了 `.md`。两处都不是文档问题，是实现缺口。

1. **`drive.list` 加了 `folder` / `pageToken`**。原来只列根，看到文件夹却进不去，等于只能看不能逛。实机验证：列出 `agent-refactor`（`RtfrfakKtl4MMhdlleecvnvknrd`）拿到 2 个文件、`has_more=false`；列出 `零抽成开发外包平台`（`CT8cfNQdQl2AOpdShF3cjk7rn3c`）拿到多个 `.md`。
2. **新增 `drive.read`**。飞书里很多「文档」其实是 Drive 上的普通文件（`.md`、`.txt`），`docs +fetch` 对它们一律 `3380002 Only docx is supported`；`drive +fetch` 则会把任意文件转成可读的 markdown 快照。实机验证：`HOWTO-agent-changes.md` → 1576 字符、`开发者档案.md` → 59 字符，内容正确。
3. 两处共用同一张动作表，所以 oauth 路线自动获得同名动作（走 download 端点、文本限定），scope 仍是 `docx:document:readonly`，risk 仍是 `read`。

残留的观感问题：`drive +fetch` 的快照首行会把文件名带一个下划线（`# HOWTO-agent-changes.md_`），是 CLI 的排版产物，不影响内容；要洗掉就在 driver 里做一次首行规整，暂时不做。

### 7.5 表格区间：为什么输出 CSV

`sheet.read` 返回的是 **CSV 文本**，不是 `[[cell…]]` 矩阵。理由有三：模型读 CSV 不需要「这一步是第几列」的说明；脚本可以直接喂 `csv.reader`；而矩阵走 JSON 会把一次 200×10 的读变成几千个嵌套括号，token 全花在标点上。

- CLI 路线：`sheets +csv-get` 自带分页拼接，返回 `{csv, actual_range, has_more?}`。
- oauth 路线：`GET /open-apis/sheets/v2/spreadsheets/<token>/values/<sheet>!<range>`，`call()` 里用 `spec.shape` 把 `valueRange.values` 矩阵转成同样的 `{csv, actual_range}` —— 两条路线给调用方的形状一致，调用方不必知道是哪条路线。
- 单元格里出现逗号、引号、换行时才加引号，是 RFC4180 的最小实现；不做全量转义（全量转义会让「看起来像数字」的列变成字符串）。
- scope `sheets:spreadsheet:readonly`，risk 仍是 `read`。

**整表读取必须裁剪**。不带 `range` 时平台按**网格**而不是按**数据**返回：一张 4 行 3 列的新表，`actual_range` 是 `A1:T200`——4000 个格子，其中 3988 个是空的。第一版原样输出，419 行 CSV 里只有 4 行有内容。现在由 `spec.post` 做尾部裁剪（去掉全空的尾行与尾列），并把 `rows`/`columns` 回给调用方；`actual_range` 保留平台原值，不改写。

**但显式 `range` 一律不裁剪**：调用方说了 `B2:B4`，就必须拿到 3 行，哪怕中间是空行——否则行号对不齐，后续写回会错位。这一条有专门断言。

**真机证据**（自建临时表 `agent-sheet-test`，`VBUhslK0LhiJt0tTSlYcuvtEnSg`，写入 4 行 3 列后立即读回，再删除）：

```
sheet.info -> title=agent-sheet-test, sheet_id=9c2b64, Sheet1, 200×20
sheet.read (整表) -> actual_range=A1:T200
name,score,city
alice,95,中山
bob,87,Shanghai
"carol, x",,"a""b"
sheet.read (B2:B4) -> csv="95\n87", row_indices=[2,3,4], current_region=A1:C4
```

最后一行暴露了「显式 range 不裁剪」这个决定的实际后果：`B4` 是空的，若裁剪就会把 3 行变成 2 行，`row_indices` 与数据行的对应关系随之崩掉。

清理动作：`drive +delete --file-token … --type sheet --yes` 返回 `{"deleted":true,"ready":true}`，文件夹回到 2 个文件。

### 7.6 写动作：谁来决定「不问就写」

写盘能力有三个动作，两个 key：文档（`doc.create` / `doc.append`）与表格（`sheet.write`）。它们和读动作共用同一张表，所以两条路线（cli / oauth）能做的事依旧一致。

**两道门，各管一件事：**

1. `scope`：`docx:document`、`sheets:spreadsheet`。缺 scope 时在起子进程之前就拒绝，不产生任何副作用。
2. `risk`：这三个动作都是 `write`。默认 `options.allow = ["read"]`，所以**默认写不了**；把 `write` 加进实例的 allow 列表才可能发生。

**「不问就写」是怎么来的：**

- `options.allow: ["read","write"]` —— 代理层不再按风险级别拒绝；
- `user/permissions.json` 里给 `lark` 记 `allow` —— 工具层不再弹确认。

两处都配了才算「直接写」，缺一处就退回「拒绝」或「询问」。这是刻意的双门：一处是「这个实例被允许做什么」，一处是「这个工具在这台机器上要不要问人」。

**保留的高风险边界**：`DELETE` 类动作（`drive +delete`）仍是 `high`，既不在 `write` 里，也不在默认允许集里；`api` 逃逸口的 DELETE 同样按 `high` 计。删除不是写，代价不可逆。

**真机证据**（自建临时表与临时文档，验完即删）：

```
sheet.write A3:B4 -> {updated_range:"4d3c33!A3:B4", updated_cells:4, revision:2}
读回 A1:B4 ->
name,score
alice,95
bob,87
"carol, x",

doc.create  -> {document_id:"Tiynda0…", title:"agent-doc-write-test", url:"https://my.feishu.cn/docx/…"}
doc.append  -> {appended_blocks:2}
doc.read    -> 64 chars, keys=content,document_id,title,revision
<title>agent-doc-write-test</title>
# 写入测试
第一段。
追加第一行
追加第二行
```

顺带补的一处一致性：`doc.read` 在 CLI 路线把正文藏在 `data.document.content`，HTTP 路线是 `data.content`；`doc.create` 的 CLI 返回里有 id 和 url 但没有 title。现在两条路线都经 `shape()` 收敛成同一组键（`content/document_id/title/revision`），调用方不必知道是谁执行的。`shape()` 也从「只有 oauth 用」改成两条路线都过一遍。

**删除是异步任务，而且列表不会说谎。** `drive +delete` 真正返回的不止 `deleted`：

```
{"deleted":true,"file_token":"PYLtd…","ready":true,"status":"success",
 "task_id":"schedule|7711185638510480332","type":"docx"}
```

`task_id` 可以拿去 `drive +task_result --scenario task_check --task-id <id>` 收尾，回 `{failed:false, ready:true, status:"success"}`。

上一节我一度把「删了还在列表里」记成列表延迟，**这个结论是错的**。查 item token 才发现列表里那个 docx 的 token 是 `PYLtd…`，而被删的是 `Tiynda…` —— 两个不同文件、同一个标题，是探针跑了两遍各建了一个。删掉第二个之后列表立刻只剩两个真实文件。教训：**遇到「删了还在」，先比对 token，别先怪缓存**；同名文件在云盘里很常见，尤其写盘探针重跑时。

### 7.7 `doc.write`：改一处和改一整篇不是一件事

动词是一个，风险是两个，所以 `doc.write` 用 `mode` 分流，`risk` 跟着 `mode` 走：

| mode | 必填 | 语义 | risk |
| --- | --- | --- | --- |
| `replace` | `pattern` | 精确替换匹配到的那一处文本；`replacement` 省略即删除匹配 | `write`（已授权则静默执行） |
| `overwrite` | `content`（非空） | 整篇重写 | `high`（**不随写权限一起放开**） |

这样「写可以不问」不会悄悄变成「可以整篇覆盖」。当前 `user/proxies.json` 的 allow 是 `["read","write"]`，所以 `replace` 静默、`overwrite` 会直接被拒（不是询问，是拒绝）。要连整篇覆盖都静默，需要显式把 `"high"` 加进 allow —— 我不建议，那是把最后一次刹车也拆了。

**平台的真实语义（实测，不是猜测）**

- `str_replace` **只允许唯一匹配**。同一段落里有两处「旧句子」，CLI 直接失败：

  ```
  degrade_code=1014, msg=str_replace pattern matched multiple locations.
  Make the pattern more specific so it matches exactly one location, or use block_replace for ambiguous cases
  ```

  这条比「全部替换」安全：它逼你把 pattern 写得更准，而不是一次改十处。
- `replacement` 传空串 = 删除该匹配，不是「替换成空内容」的另一种说法。
- 成功返回里 revision 在 `data.document.revision_id`，不在顶层；`shape()` 已兼容两种位置。

**顺手修的一个真实缺陷**：这类「软失败」的 CLI 输出是 `{ok:false, data:{result:"failed", warnings:[…]}}`，既没有 `error` 字段、退出码又是 1。原来 `runner.interpret()` 只认 `error` 字段，于是把最有信息量的那句 warning 丢掉、只留「exited 1」。现在没有 `error` 但有 `warnings` 时，warning 原文进错误信息 —— 否则模型看到「exit 1」只能瞎猜。

**真机证据**（自建临时文档，验完 `drive +delete` + `task_check` 收尾）：

```
input:  "# 覆盖测试 … 旧句子出现两次：旧句子。还有旧句子。 最后一段。"
replace {pattern:"旧句子"} -> 报 1014：matched multiple locations（拒绝，不是全替换）
replace {pattern:"只剩这一句。", replacement:"改写成功。"}
  -> {"mode":"replace","revision":7,...}，读回正文确实变成「改写成功。」
overwrite {content:"# 收尾\n\n第二次覆盖。"}
  -> {"mode":"overwrite","revision":9,"overwritten":true}，读回只剩新内容
```

**路线差异（此处原先写错了，已更正）**：这一节最早写的是「oauth 没有文本替换原语、也没有靠谱的整篇重写原语，所以明确拒绝」。这个结论是错的，错在把 `docx/v1/blocks` 当成了唯一可能的实现路径。实际上 CLI 的 `docs +update` 走的不是块 API，而是一个**命令式端点** `PUT /open-apis/docs_ai/v1/documents/:document_id`，body 里 `command` 取 `str_replace | block_replace | block_insert_after | block_delete | overwrite`。也就是说 oauth 什么都能做，只是要走这个端点。现在两条路线共用同一份 `docWriteArgs/docWriteBody/docWriteShape`，没有「一半能写一半不能」。实测与细节见 7.13。

### 7.8 批量写表与批量删除：一个是平台批，一个是进程批

两个「批量」长得像，实现完全不同，混着看会误解成本。

**`sheet.write` 多区域 = 一条请求**

`params.writes` 是数组（上限 100），每项 `{sheet|sheetId?, range, values}`。CLI 有原生 `--writes`，整批走**一次**批处理请求且 fail-fast：要么都成，要么在失败处停下，不会留下「写了一半」的表。项内不带 sheet 选择器时，回落到顶层的 `sheet`。

```
multi write -> {"updated_ranges":["Sheet1!A1:B2","Sheet1!D1:E2"],"updated_cells":8,"revision":1}
读回 A1:B2 -> name,score / alice,95
读回 D1:E2 -> 远端,1 / 批量,2
```

`updated_ranges` 和 `updated_cells` 是我们自己算的（平台回的是别的形状），方便调用方核对「我要求的区域是不是都写了」。

**`drive.delete` 多文件 = N 个进程**

平台的删除是单 token 的异步任务，CLI 也只删一个。所以 `drive.delete` 的 `expand()` 把一次调用摊成 N 次，driver 按项跑、按项收：

```
delete 3 个文件 -> {"deleted":[{"file_token":"…","type":"sheet","deleted":true,
                                "task_id":"schedule|…","ready":true,"status":"success"}, …],
                    "failed":[], "attempted":3}
```

三项全部 `status:"success"`，拿 `task_id` 逐个 `drive +task_result --scenario task_check` 复核都是 `success / failed:false`，之后根目录与 `agent-refactor` 文件夹都恢复原样（只剩两个真实文件夹 + 两个既有文件）。

三条设计约束：

1. **risk 恒 `high`**，不随 `write` 放开。删除没有 undo，当前 `options.allow = ["read","write"]` 时它会被直接拒绝；要用就必须显式把 `"high"` 加进 allow。
2. **上限 20 个/次**、类型必须在白名单（`file|docx|doc|sheet|bitable|mindnote|folder|shortcut|slides`），非法类型在起进程前抛错。
3. **逐份回报**：多文件调用里单个失败不会中断整批，会进 `failed[{token,type,error}]`；单文件调用仍然直接抛出，不吞错。

**顺手修掉的一个假事实**：`sheet.info` 的测试以前断言 `sheets[0].title`，而真实 CLI 的字段叫 `sheet_name` —— 那是 fake fixture 编的名字，测试一直在验证自己的假设。现在 `sheet.info` 有 `shape()` 把 `sheet_name` 归一成 `title`（同时给出 `rows/columns/hidden`），fixture 也改成真名，测试才真正对得上平台。

### 7.9 块、消息、文件：三块能力的真实边界

**块级读写：`doc.blocks` + 三个块模式**

文本视角会骗人。`doc.read` 给你 markdown，但「删掉第三段」「替换这个表格」需要块 id，所以加了 `doc.blocks`：

```
blocks: <doc>:page:"" | doxcnkf…:h1:"块测试" | doxcn2Y…:text:"第一段。"
        | doxcng0…:text:"第二段。" | doxcnqQ…:text:"第三段。"
```

`block_type` 是数字枚举、正文藏在类型同名的键里（`text` / `heading1` / `bullet`…），`shape()` 把它压平成 `{block_id, type, text}`：调用方要决策的只有这三样，原始块不该进上下文。

`doc.write` 因此多了三个 mode：

| mode | 必填 | 对应 CLI | risk |
| --- | --- | --- | --- |
| `block.replace` | `blockId` + `content` | `--command block_replace` | write |
| `block.insert` | `blockId` + `content` | `--command block_insert_after` | write |
| `block.delete` | `blockId`/`blockIds` 或 `startBlockId`+`endBlockId` | `--command block_delete` | **high** |

真机一轮（同一文档，revision 连续）：

```
block.replace 第二段。 -> 第二段已替换。   revision 4
block.insert  第一段后 -> 插在第一段之后。 revision 5
block.delete  第三段。 -> deleted_blocks:1 revision 6
最终 blocks: page | h1:块测试 | text:第一段。 | text:插在第一段之后。 | text:第二段已替换。
```

`im.send`：**以人的身份说话**

`{chatId|userId}` 二选一、`{text|markdown}` 二选一，冲突时在起进程前就拒。真机发给自己（`ou_…`）返回：

```
{"message_id":"om_x100b7f0ede11c8bcde843556f267bda","chat_id":"oc_8283fef6df8155cd7a85bdceabe93458",
 "receiver_type":"open_id","msg_type":"text"}
```

注意：**scope 门在配置里也卡了一道**。第一次跑报 `scope "im:message" is not granted`，把 `im:message` 加进 `user/proxies.json` 的 scopes 才发出去 —— 声明式 scope 和真实 token 授予是两件事，两个都要真。发送是 write 不是 high：发错能撤回。

**文件进出：`drive.upload` / `drive.export`**

这两个动作最危险的地方不是 API，是**路径**。模型能指定本地路径，就能读走机器上的密钥，所以两个方向都限制在 `fileRoot`（默认 `PROJECT_ROOT`，可用 `options.fileRoot` 放宽）；`/etc/passwd` 在起进程前就被拒，且不会读文件。

真机验证：

```
upload docs/accounts/proxy.md -> {"file_token":"WwGhbRsr…","name":"upload-probe.md","parent":"Rtfrfak…"}
drive.list 立刻能看到 upload-probe.md
export FlondPos… (docx) -> pdf {"path":"…/tmp-export3/agent-blocks-test.pdf","bytes":29985,
                                "file_token":"VbsWbkJR…","ticket":"7711193489284353216"}
```

`drive.export` 有两处必须说明：

1. CLI 的返回字段叫 `saved_path` / `size_bytes`，不是 `path` / `bytes` —— 第一次实现按 `path` 取值，拿到空字符串，文件其实早落盘了。已按真名取值，并同时回 `name/file_token/ticket`。
2. **裸 token 必须显式 `docType`**。飞书的 token 是随机串（`FlondPos…`），没有类型前缀，猜不出来；只有传 URL 时 CLI 才能自己推断。所以「猜类型」这条路被删掉了，改成「要么给 URL，要么给 docType」。

收尾：5 个临时产物（4 个上传的 md + 1 个测试 docx）用一次 `drive.delete` 全删，`task_check` 五次都是 `success/failed:false`，文件夹恢复两个文件。

**顺带修的两处真实缺陷**

- **网络超时被当成平台拒绝**。`block.insert` 真机撞到 `exit 4, {"type":"network","subtype":"timeout"}`，而这段 JSON 在 **stderr** 上、stdout 是空的。原来的 `interpret()` 只解析 stdout，于是降级成「exited 4: {原始 JSON}」并判成 platform（不重试）。现在 stderr 的 JSON 也解析，且 `type:"network"` 直接判 `retryable`，重试后同一调用成功。
- **测试断言了自己编的字段**。`sheet.info` 断言 `sheets[0].title`，真机字段是 `sheet_name`。这条已在 7.8 记过，本轮 `doc.blocks` 的 fixture 直接按真机结构写（`block_type` 数字 + 类型同名键），避免再犯。

**路线差异**：`doc.blocks`、`im.send` 两条路线都实现了（HTTP 用 docx blocks / im messages 端点，均在假平台上验证）；`drive.upload`、`drive.export` 是 cli-only —— 上传要 multipart、导出要走平台异步任务加本地落盘，oauth 路线明确拒绝而不是做半套。

### 7.10 `drive.read` 分段读：把「文件」当成字节，不是当成字符串

原来的 `drive.read` 只有两种结局：小文本读回来、二进制或超过 256KB 报错。两个都是死路——真实云盘里 80% 是二进制，而 agent 读一份 5MB 日志本来就应该分段。

现在一次 `drive.read` 是一个**字节切片**：

| 字段 | 含义 |
| --- | --- |
| `content` | 文本片段，或 base64 片段 |
| `encoding` | `text` / `base64`，决定 `content` 怎么解 |
| `offset` / `next_offset` | 本次起点 / 下次起点（**按实际消费的字节算**） |
| `bytes_read` | 本次消费字节数（可能小于请求的 `limit`） |
| `total_bytes` / `eof` | 文件总长 / 是否到末尾 |

**编码是嗅出来的**，不是按扩展名猜：出现 NUL 字节或 UTF-8 严格解码失败 → `base64`，否则 `text`。

**关键细节：文本切片不能切在多字节字符中间。** 按 `limit` 硬切 UTF-8 会出现半截汉字，下一次读就会得到乱码。实现上先按字节切，再用 `TextDecoder({fatal:true})` 从尾部回退 1–3 字节直到能解，`next_offset` 跟着「回退后的长度」走。这保证了「按 offset 连续读 N 次，拼接结果与原字节完全一致」。

**cache 是分段读成立的前提**：CLI 的 `+download` 只能整份下载，所以第一次读把文件落到 `user/.cache/drive/<token>.bin`，之后每个 offset 都是本地 `pread`，不再走网络。`refresh:true` 强制重下（文件被覆盖后必须用它，否则读到旧内容）。

**真机证据**（自己上传的文件，验完删除）：

```
probe.bin  total=300000  calls=5   got=300000  sha256 same=true
probe.md   total=252019  calls=62  got=252019  sha256 same=true   (4096 字节一片，中文多字节边界)
```

第二条是核心：252KB 中文按 4096 字节切了 62 次，SHA-256 与原文件一致 —— 说明边界回退是对的，不是「看起来没乱码」。

**路线差异**：cli 走「下载 + 本地 seek」，真正不把大文件读进内存；oauth 没有 rang GET，只能整份拉下来在内存里切片（上限 8MB），超了明确报错让走 cli。原来 256KB 文本上限与「二进制一律拒绝」的行为已移除。

**已知取舍**：cache 没有淘汰策略、也不按 revision 失效，key 只有 token；同名文件被覆盖后必须显式 `refresh`。清理靠人（`rm -rf user/.cache/drive`），不做后台任务——这台机器后台进程会被回收，本来也做不了。

### 7.11 IM 读侧：三个动作，三把不同的锁

写侧只有一个 `im.send`，读侧拆成三个动作，因为它们的授权范围与分页行为都不一样：

| 动作 | 做什么 | scope | risk |
| --- | --- | --- | --- |
| `im.chats` | 列出我是成员的会话（群 / 私聊 / 话题） | `im:chat:readonly` | read |
| `im.messages` | 读某个会话的消息，或某个人的私聊 | `im:message:readonly` | read |
| `im.search` | 跨会话搜消息（关键词 + 人 + 时间窗） | `im:message:readonly` | read |

**统一的消息形状**（这是本轮真正花的功夫）：CLI 直接给渲染好的 `content` 字符串，HTTP API 把同样的文本塞在 `body.content` 的 JSON 里，时间一个是 `"2026-11-23 10:46"`、一个是毫秒时间戳。`normalizeMessage()` 把两边收敛成一组键：

```
{message_id, chat_id, chat_type, create_time, msg_type, text,
 sender_id, sender_name, sender_type, deleted}
```

时间统一成 ISO（数字/13 位字符串按毫秒转），文本从 `body.content` 里解出来，解不动就原样保留。

**reactions 默认不取**：CLI 默认会给每条消息补表情回应，那是每条一个额外请求。读文本的人不该为此付费，所以除非显式 `includeReactions:true`，一律带 `--no-reactions`。

**真机结果**（自己的账号，只读，没有产生任何副作用）：

```
im.chats(types:"group,p2p", excludeMuted)
  -> group:oc_7c67… | p2p:账号安全中心 | group:魏宁's Feishu Assistant | p2p:审批
     | group:小微企业/创业团队_服务中台_讨论 | topic:数字开发工作组 | p2p:飞行社 …

im.messages(chatId:"oc_8283…", pageSize:3)
  -> 2026-11-23 10:46 wing: 自测：lark proxy im.send 已接通
     2026-11-17 21:03 wing: https://rcne0lfduyr7.feishu.cn/wiki/…

im.messages(userId:"ou_c4a8…")  // 私聊按人找
  -> {"chat":"wing和wing的会话","n":2,...}

im.search(query:"lark proxy")
  -> ["自测：lark proxy im.send 已接通 （由豆包工作发送）"]
```

注意 `im.chats` 会把 `chat_mode:"topic"` 的话题会话也带出来——`--types` 只有 group/p2p 两档，话题群在平台侧仍属群，我们没有把它过滤掉，而是原样透出，避免「静默丢数据」。

**路线差异（补齐后）**：三条都有 HTTP 实现（`GET /im/v1/chats`、`GET /im/v1/messages`、`POST /im/v1/messages/search`，端点取自 CLI 的 `--dry-run`，不是猜的）。

`im.messages` 的 `userId` 在 oauth 上原本是缺口：消息端点只认 chat_id。现在补上了，做法是**先解析人，再读会话**：

```
POST /open-apis/im/v1/chat_p2p/batch_query   body {"chatter_ids":["ou_…"]}
  -> {"p2p_chats":[{"chat_id":"oc_8283fef6df8155cd7a85bdceabe93458",
                    "chatter_id1":"ou_c4a8…","chatter_id2":"ou_c4a8…"}]}
GET  /open-apis/im/v1/messages?container_id=<resolved>&container_id_type=chat
```

这个 body 形状不是猜的：先拿 `{}` 打了一次拿到 `99992402 field validation failed`（说明必填字段没给），再依次试 `user_ids`、`chats[{user_id}]` 都被拒，`chatter_ids` 一次通过。CLI 的 `--dry-run` 也直接写了这一步（`Will resolve P2P chat_id via POST /open-apis/im/v1/chat_p2p/batch_query`）。

**「找不到 p2p 会话」是答案，不是错误**：`p2p_chats` 里没有命中就说明这个人从没和你单独聊过。这时报 `im.messages found no p2p chat with "ou_…" — they have never messaged you`，而不是返回一个空消息列表让人以为「没消息」。空列表和「不存在会话」是两件事。

cli 路线不需要这一步：`--user-id` 由 CLI 自己解析（同一端点），所以 `run` 钩子里 cli 分支只是照原样起进程。

**scope 上的又一次教训**：上一轮 `im:message` 是发消息，这一轮读要 `im:chat:readonly` 与 `im:message:readonly`，两者不互相覆盖。配置里三个都写上了，真机一次通过——但这说明**scope 是按动作精确声明的，不是按域打包的**。

### 7.12 `drive.search`：找文件，而不是走文件夹

`drive.list` 一次只看一层，所以「找一份三天前写的东西」等于必须先想起路径。`drive.search` 是唯一能按内容问「我写过 X 吗」的动作，端点是 `POST /open-apis/search/v2/doc_wiki/search`（Search v2），scope `search:docs:read`（和 `drive:drive:readonly` 不覆盖彼此——scope 又一次是按动作声明的）。

**动作参数**：`query?`（最多 30 个码点，超了会截断并在 `notice` 里说明）、`docTypes`（doc/sheet/bitable/mindnote/file/wiki/docx/folder/catalog/slides/shortcut）、`folderTokens`、`mine`、`creatorIds`、`sort`（default/edit_time/edit_time_asc/open_time/create_time）、`onlyTitle`、`pageSize`（1–20）、`pageToken`。返回 `results[]{token,title,type,file_type,entity,url,owner_id,owner_name,created_at,updated_at,cross_tenant,snippet}` + `has_more`/`page_token`/`total`。

**平台怪癖一：少了 `doc_filter` 就是静默的 0。** 这不是报错，是「什么都没匹配到」的样子。实测：

```
{"query":"HOWTO","page_size":3}                    -> total 0, res_units []
{"query":"HOWTO","page_size":3,"doc_filter":{}}    -> total 61
```

同一个 query、同一个 page_size，只差一个空对象。所以请求体里 `doc_filter` 永远存在（哪怕空），`wiki_filter` 也对称地写同一份筛选条件——只写 `doc_filter` 会让 wiki 命中消失。假平台照这个行为实现（无 `doc_filter` 就答 0），所以单测里「total 非 0」本身就是「请求体带了筛选器」的证据。

**平台怪癖二：无 scope 的浏览也是静默的 0。** 没有 query、也没有人/文件夹限定时，服务端不知道该在哪找。所以 `searchPlan()` 在起进程/发请求之前就拒：`drive.search needs a query or a scope filter (mine, creatorIds or folderTokens): an unscoped browse answers 0`。把「空结果」和「没问对」区分开，是这个动作里最重要的一条。

**真实字段**：原始响应是 `res_units`（不是 `results`，那是 CLI 归一后的键），时间戳只有秒（`create_time: 1795366356`），`*_iso` 是 CLI 加的——所以 `isoFrom()` 两条路线都能用。标题带高亮标记且 HTML 转义（`<h>HOWTO</h>`、`&lt;API name&gt;`），`plainText()` 剥标签 + 解实体，`<h>` 出现在词中间也不会留残渣（真机 `agent` 命中返回 `FOLDER agent-refactor`、`HOWTO-agent-changes.md` 都是干净的）。

**oauth 的 `mine`**：平台侧的 `mine` 是「按 owner open_id 过滤」，HTTP 路线没有 CLI 的身份，所以先从 `/authen/v1/user_info` 拿 `open_id` 再拼 `creator_ids`。拿不到就明确失败，不降级成「全部」。

**A/B 对齐（真机）**：CLI `drive +search --query agent --mine --only-title --page-size 5` 与我们 HTTP 路线拼出的同义 body（`creator_ids` + `only_title` 分别写进 `doc_filter`/`wiki_filter`）返回**完全相同的 4 条、相同顺序**。这是「两条路线语义等价」的直接证据，而不是口头承诺。

**真机读到的结果**（cli 路线，过滤链一次通过）：

- `query "HOWTO"` → total 61，前 5 条含 `doc/file:md HOWTO-agent-changes.md` 两份（同名不同 token，就是之前那次重复上传）、`doc/docx API Guide`、两份 sheet。
- `mine:true` → total 11，包括自己建的 `folder agent-refactor` 和 `wiki/docx 知识问答`，顺带证实**文件夹也被索引**。
- `folderTokens:[RtfrfakKtl4MMhdlleecvnvknrd]`（agent-refactor）→ total 2，正好是该文件夹里的两个文件（`HOWTO-agent-changes.md`、`agent-all-changes.mbox`）。这条是「按文件夹浏览」的能力，不需要 query。
- `docTypes:"docx"` + `sort:"edit_time"` → total 9，排在前面的是最近编辑的 wiki 文档。

**边界**：`folderTokens` 是 doc-only（给了它就不发 `wiki_filter`，CLI 也这么干）；跨租户命中有 `cross_tenant:true`（实测有 `waytoagi.feishu.cn` 的文档），这类文档后续 `doc.read` 可能被权限拒绝，标记出来比替你猜更诚实。

> **更正（M13）**：上一段原来写着「`spaceIds` 没有做，因为需要 wiki 侧 scope」。做完之后发现 scope 并不是障碍（`search:docs:read` 一条覆盖两边），真正的障碍是**请求体形状**——见 7.15。

### 7.13 `docs_ai` 命令端点：块语义在两条路线上都成立

补 oauth 的块语义时发现了一件比「补功能」更重要的事：**CLI 的块操作根本不是 docx 块 API**，而是一个命令式端点。`--dry-run` 一打就露出来：

```
PUT /open-apis/docs_ai/v1/documents/{document_id}
{"scene":"DoubaoCLI","command":"block_replace","block_id":"blk…","content":"…","format":"xml|markdown","revision_id":-1}
```

支持的 `command`（平台原话，`append` 试出来的报错里列的）：`str_replace`、`str_delete`、`block_insert_after`、`block_replace`、`block_delete`、`block_move_after`、`block_copy_insert_after`、`overwrite`。

三条实测结论：

- **`append` 是 CLI 的糖**：平台不认，CLI 把它翻成 `block_insert_after` + `block_id:"-1"`（文档末尾哨兵）。
- **`block_id` 的语义是「插到根块之后」= 文档开头**，不是末尾：对根块 insert 一次，新内容出现在最前面。要追加必须用 `-1`。这个反直觉点没实测就会写错。
- **`str_delete` 存在但 CLI 不暴露**：删文本用空的 `str_replace` 已经够，不需要单独动作。
- `scene` 与 `revision_id` 都可省略（省略 `scene` 也成功），`format:"markdown"` 被接受 —— 也就是说 `--doc-format markdown` 的映射是对的。

**多块删除是一个逗号分隔的字段**：`block_id:"b2,b3"`，不是数组、不是「每个一块一次请求」。范围删除走 `start_block_id`/`end_block_id`。

**真机证据（走的是真 oauth 代码路径，不是 raw curl）**：把沙箱里的 `DOUBAO_OFFICE_USER_ACCESS_TOKEN` 注入 oauth 实例的 `credentials.accessToken`，`baseUrl` 指向真 `open.feishu.cn`，然后 `proxy.call("doc.write", …)` 五种 mode 各跑一遍，每步都读回正文对照：

```
block.insert  {blockId:"-1"}    -> revision 5  success  doc: 末尾多出「### 追加小节」
block.replace {blockId:h2}      -> revision 6  success  doc: 「## 标题A」变成「## 标题Z」
replace       {pattern:"段落一"} -> revision 7  success  doc: 「段落一」变成「段落壹」
block.delete  {blockId:para}    -> revision 8  success  doc: 段落消失
overwrite     {content:"# 重写后"} -> revision 10 success  doc: 全文只剩新内容
```

一次跑通、revision 单调递增、每步内容都对得上。**所以 7.7 那句「oauth 做不到」是错的，已在原处更正**：错因是把「唯一的实现路径」当成「唯一可能的实现」。

顺带记一条验证成本：oauth 路线此前一直只在假平台上验证，因为「没有真 appId/secret」。但只要愿意把沙箱 token 当成 access token 注入，整条 HTTP 链路（含 bearer、scope 校验、响应字段）都能真机打 —— 这比「等有凭据再说」有用得多，也立刻暴露出下面那个字段错误。

### 7.14 话题内回复读取：消息 id 不是会话

话题群里每条根消息自成一个 thread（`omt_…`），但调用方手上通常只有一个消息 id（`om_…`）。`im.messages` 因此多了 `thread` / `threadId` 入参：

- `thread: "omt_…"` → 直接用；
- `thread: "om_…"` → 先 `GET /open-apis/im/v1/messages/:message_id` 取 `items[].thread_id`；
- 读的时候 `GET /open-apis/im/v1/messages` 只换 `container_id_type=thread`（同一端点，和聊天读取共用），`sort_type` 按 `order` 走 `ByCreateTimeAsc/Desc`；话题默认 **asc**（回复链是对话，倒着读才奇怪）。

**「没有 thread」是答案，不是空列表**：普通群/私聊的消息 `thread_id` 为空，这时报 `message "om_…" has no thread — it is not in a topic group, so there are no thread replies to read`。实测私聊消息 `om_x100b7f0e…` 打出来的就是这个，而不是 `messages: []`。

**又一次「测试断言了自己编的字段」**：oauth 路线拿到 `sender_name: ""`，因为真平台把名字放在 `sender.sender_name`（还有 `sender.sender_i18n_names.zh_cn`），而假平台 fixture 里写的是 `sender.name`（那是 CLI 渲染形状）。测试全绿、真机是空。现在 `sender_name` 取 `name || sender_name || i18n[zh_cn | 第一个字符串]`，fixture 也改成平台真字段，测试才真正覆盖到。

同批补的两个「读起来才有用的字段」：

- `thread_id` 出现在每条消息里（从聊天读取也能直接跳进某个话题）；
- `parent_id`（平台侧 `parent_id`，退化到 `root_id`）：这是「这条回复在回哪一条」，也是唯一能重建回复树的信息；
- thread 容器本身不返回 `chat_id`/`chat_name`，所以从第一条消息的 `chat_id`/`chat_default_name` 回填 —— 否则调用方拿到一个没有出处的消息列表。

**一条路线差异要说清**：`parent_id` 只在 oauth 路线有。CLI 把消息渲染成扁平结构，原始响应里的 `parent_id`/`root_id` 被它丢掉了（实测 `+threads-messages-list` 的字段表里没有这两项），所以 cli 路线的 `parent_id` 为空。要重建回复树得走 oauth，或在 cli 上接受「顺序即结构」。

**真机证据（oauth 代码路径，真 token）**：`thread: "om_x100b414779f120cc…"` → 先解析出 `omt_1b82bbbaecc9d75e`，再读到整串回复，`sender_name:"滕怀王"`、`parent_id` 都在；`threadId:"omt_…"` 直接读同样成功（只一次请求）；私聊消息按上面的方式明确失败。

### 7.15 把两把只做一半的锁补齐：回复一条消息、只在某个空间里搜

这一批补的是「同一动作的另一半」：`im.send` 原来只会**新发**一条，`drive.search` 原来只会按 query/人/文件夹找。两件事的共同点是——补齐靠的不是新能力，而是把平台已经有的那条路走通。

**回复：`replyTo` 而不是「另开一个会话」。** `im.send` 多了 `{replyTo, text|markdown, inThread?, idempotencyKey?}` 这一支，两条路线落到同一个端点：

```
CLI:  im +messages-reply --message-id om_… [--text|--markdown|--content] [--reply-in-thread] [--idempotency-key k]
HTTP: POST /open-apis/im/v1/messages/:message_id/reply
      {"content":"{…}","msg_type":"text","reply_in_thread":true,"uuid":"k"}
```

`--dry-run` 一次打全了这三个字段，`--idempotency-key` 在 reply 上也真的映射到 `uuid`（不是只在新发时支持），所以 oauth 侧也补了同一个 `uuid`——否则同一条回复重试两次会在平台上变成两条。

**回复不能带接收人。** `replyTo` 与 `chatId`/`userId` 同时出现时，在起进程之前就拒：「a reply belongs to the message, not to a chat」。理由是这条目标信息本来就有歧义：消息属于哪个会话由 `message_id` 决定，再给一个 chat 只会让两条目标打架，而平台不会替我们挑。

**真机验证（cli 路线）**：把我自己私聊里的一条消息 `om_x100b7f0e…` 当回复目标，`im.send {replyTo, text, idempotencyKey}` → 新消息 `om_x100b7f0f…`，`chat_id` 自动回填成该私聊、`reply_to` 就是原消息、`in_thread:false`；再 `im.messages` 读回，新消息在原消息之上、正文正确。选私聊是为了不打扰任何人——`inThread` 只做了 dry-run 与假平台验证，往真实话题群发回复会吵到同事，这件事留到有需要时再打。

**一条必须说清的路线差异：CLI 给文字加后缀。** 同一条 `--text`，cli 路线发出去是 `原文 （由豆包工作发送）`，oauth 路线是我们自己拼 `content`、没有后缀。`--text`/`--markdown`/`--content`（`text` 与 `post`）都会带，`--image` 不带；`LARKSUITE_CLI_BRAND` 改了无效，也没有相关 flag（`grep -i sign|suffix|brand` 全空）。所以「两条路线语义等价」在**读**侧成立，在**写**侧要打个引号：**正文内容会不同**。

**决定（2026-11-23，已接受）**：不改代码、不改配置，把这个后缀当成 cli 路线的平台事实，写进文档与动作描述里；需要正文逐字一致的场合（对外通知、需要引用的正文、回归比对）走 oauth 路线。判据很简单——**「人读到什么」用 cli 无所谓，「程序比对什么」必须走 oauth**。反过来说，任何拿 cli 路线发出的文本去做 diff/断言的地方，都要先把这段后缀剥掉，或者干脆别用它当基准。

**搜索：空间、群、人、密级、时间。** `drive.search` 现在接受 `spaceIds`（知识空间，wiki-only）、`chatIds`（群内分享过）、`sharerIds`、`secureLabelIds`、`onlyComment`、`createdByMe`（= 我原创，解析成 `original_creator_ids`，与 `creatorIds`/`mine` 的 owner 语义不同）、`originalCreatorIds`，以及四组窗口 `createdSince/Until`、`openedSince/Until`、`editedSince/Until`、`commentedSince/Until`。`folderTokens` 与 `spaceIds` 互斥（一个 doc-only、一个 wiki-only），同时给就在起进程前拒。

**时间是同一个解析器喂两条路线。** 接受 unix 秒、`YYYY-MM-DD`（按 +08:00 零点）、ISO、以及相对 `7d`/`1m`/`1y`（按日历减，不是减 `n*86400`）。解析在 `searchPlan()` 里做一次，cli 与 HTTP 拿到的是同一个整数——所以「7d」不会被 CLI 自己再解释一遍，两条路线不可能漂。`my_edit_time`/`my_comment_time` 服务端按小时取整，所以这两个窗口我们自己先 floor 到整点再发，不在文档里假装窗口是精确的。另外拒绝「看起来像秒但不是时间戳」的小整数：`31536000` 平台会当成 1971 年再报 `invalid_argument`，不如自己先说清楚 epoch 秒是 10 位。

**空间搜索的关键是一个「必须缺席」的字段。** 实测三种 body：

```
{"query":"API","doc_filter":{},"wiki_filter":{"space_ids":[…],"sort_type":"EDIT_TIME"}} -> total 0
{"query":"API","wiki_filter":{"space_ids":[…],"sort_type":"EDIT_TIME"}}                -> total 200
{"query":"API","doc_filter":{"folder_tokens":[…]},"wiki_filter":{…}}                   -> 0（folder+space 混着问）
```

所以 `spaceIds` 分支**完全不发 `doc_filter`**，`sort_type` 也跟着进 `wiki_filter`（CLI 的映射与此一致）。这和 7.12 那条「`doc_filter` 必须永远存在」看起来冲突，其实不是：真相是**两个 filter 都没有**才答 0，只发 `wiki_filter` 是合法的。7.12 的结论是在**没有 space** 的前提下测出来的，当时的措辞把前提说丢了。

**假平台跟着改，因为旧行为本身就是错的**：fixture 原来按「缺 `doc_filter` 就答 0」实现，于是新测试 `spaceIds` 打回来 `total 0`——失败的是**假平台的信念**，不是代码。现在 fixture 按「两个都没有才答 0」实现，并且 wiki-only 时从 `wiki_filter` 取 `doc_types`，测试才真正在验证新语义。

**真机数字（cli 路线，全部 `search:docs:read`）**：

```
space only (query "API", space 7226178700923011075)  -> total 200
+ docTypes docx                                     -> total 200
+ createdSince 30d                                  -> total 138
+ createdSince 1y                                   -> total 200
+ editedSince 1y                                     -> total 0
```

**顺手测出一个「窗口合理、字段不活」的事**：`editedSince` 一路都是 0，连当天刚改过的文档也不命中——`mine + editedSince 7d` 是 0，而 `mine + createdSince 7d` 是 5（那 5 份正是本轮探针产物）。所以 `my_edit_time` 在这个账号上似乎根本没有被索引。这不是我们拼错字段（`--dry-run` 与 raw body 都确认是 `my_edit_time`），是平台侧的实际状态。处理方式：**保留参数，但在「用了编辑/评论窗口且 total 为 0」时给出一条 notice**，把「改用 `createdSince`」写在结果里，而不是让人对着 0 猜。宁可多一句诊断，也不要一个看起来像「没有结果」的空。

**边界**：`inThread` 仍只做过 dry-run/假平台；`secureLabelIds` 需要租户开了密级才有意义，这边只能验证「字段被接受」；`docTypes` 里的非文本类型（图片/文件）没有逐个测。

### 7.16 非文本消息：一条消息一种内容，四种标签

`im.send` 与 `im.send {replyTo}` 现在都能发图片、文件、语音、视频。平台把它们当成**四种不同的消息类型**，每种只装一个上传后的 key：

| 参数 | `msg_type` | content 字段 | 上传端点 / `file_type` | 上限 |
| --- | --- | --- | --- | --- |
| `image` | `image` | `image_key` | `POST /im/v1/images`（`image_type=message`） | 10 MB |
| `file` | `file` | `file_key` | `POST /im/v1/files`（`stream`） | 30 MB |
| `audio` | `audio` | `file_key` | 同上，`opus`（只能是 Opus/Ogg） | 30 MB |
| `video` | `media` | `file_key` + `image_key`（封面） | 同上 `mp4` + 一张 `images` | 30 MB |

这张表就是全部差异，所以它只有一份（`MEDIA_TYPES`）：字段名写错的表现是「消息发出去了但内容为空」，比报错更难查。

**三种输入形态，两条路线都接受**：已上传的 key（`img_…` / `file_…`）、`http(s)` URL、`fileRoot` 内的本地路径。key 按类型校验（给 `image` 传 `file_…` 会明确说「takes img_… keys」）；URL 由两条路线各自下载/解析；本地路径走和 `drive.upload` 同一套 `resolveLocalPath`，**不许出 `fileRoot`**——发图同样是「把本机文件送出去」，没有理由用比传文件更松的规则。

**cli 路线的一个硬约束：只认 cwd 相对路径。** `--image` 拒绝绝对路径和 `..`（帮助里写着），所以本地附件传的是 basename，进程的工作目录被钉到该文件所在目录（`runner.run` 新增 `cwd`，`ctx.cli(argv, opts)` 透传）。由此多出一条真约束：**`video` 与 `videoCover` 必须同目录**——一个进程只有一个 cwd，猜哪个都会发错文件，所以直接拒。key 与 URL 不需要 cwd，这一点测试用「fake cli 记录自己的 `process.cwd()`」来证明，而不是靠读代码相信。

**语音必须是 Opus。** 平台侧 `audio` 只吃 Opus/Ogg（CLI 的帮助也这么写），mp3/wav 会被拒。所以本地路径的扩展名不是 `.opus`/`.ogg` 时**在起进程/发请求之前**就拒，并给出两条出路：`ffmpeg -c:a libopus` 转一遍，或者当普通 `file` 发出去。这条不靠平台报错兜底，因为平台的报错只说「invalid」。

**`video` 必须有封面。** CLI 的 `--video` 强制 `--video-cover`；oauth 侧平台的 `media` content 里 `image_key` 也是实际需要渲染的。两条路线统一要求 `videoCover`，没有它就拒——否则就是「cli 报错、oauth 发出一条没有封面的视频」，两种坏结果。

**一条消息只有一种内容。** `text`/`markdown`/`image`/`file`/`audio`/`video` 只能出现一个，出现两个就在起进程前拒（`takes one content kind, got text + image`）。`videoCover` 单独出现也拒（`videoCover` 只属于 `video`）。这批拒绝全部发生在进程/请求之前，测试断言 `recorded(file)` 为空。

**oauth 路线是两步：先上传，再发消息。** 这是它和 cli 路线唯一的结构差异：`/im/v1/images` 与 `/im/v1/files` 都是 multipart，拿回 `image_key`/`file_key` 后再 `POST /im/v1/messages`（或 `/:id/reply`）。所以 `im.send` 在 oauth 侧走 `spec.run` 而不是一次性 body，回复与新发共用这一段——回复带附件不需要第二条代码路径。

**两次真机教训（都是假平台抓不到的）**：

1. multipart 的**字段名是契约**：`/im/v1/images` 要 `image`，`/im/v1/files` 要 `file`。第一版统一用了 `file`，结果图片上传回一个光秃秃的 `234001 Invalid request param`，文件上传却正常——因为只有一个端点对字段名敏感。现在 `fileField` 是参数的一部分，假平台也记录这个字段名，测试里断言 `uploads[0].field === "image"`。
2. 上传请求**不能带 JSON 的 `Content-Type`**：手写的 `application/json` 会让 multipart 直接 400。`request()` 现在遇到 `form` 就完全不设 Content-Type，让 fetch 自己带 boundary（假平台对非 multipart 的请求回 `99992402`，测试覆盖）。

**真机证据（两条路线各四发）**：同一个私聊会话，`image / file / audio / video(+cover)` 依次发出，返回 `msg_type` 分别是 `image / file / audio / media`；随后 `im.messages` 读回，四条消息的类型与内容都对得上（`<video key="file_v3_0017n_3…"`、`<audio key=…`、`<file key=…`、`[Image: img_v3_0217n_7…]`）。cli 路线是 `lark-cli` 自己上传（stderr 会打 `uploading image: …`），oauth 路线是我们两次请求——结果形状一致，调用方不需要知道是哪种。

**形状上的取舍**：返回体只有 `message_id`/`chat_id`/`msg_type`（回复再加 `reply_to`/`in_thread`），**不回传上传得到的 key**。cli 路线的 key 在 CLI 内部生成、拿不到；为了两条路线返回同一个形状，oauth 侧也不回传。需要复用 key 的场景（同图发多个群）第一版没有做，因为它要求「上传」成为一个独立动作，而现在上传只是发送的中间步骤。

**边界**：仍不支持撤回/编辑消息（平台侧也没有对等的用户身份接口）；`interactive`（卡片）、`share_chat`、`share_user` 没有做——它们的 content 是另一套结构，不是「一个 key」，需要单独一轮；图片/视频的宽高、缩略由平台生成，我们不做预处理（除了语音的 Opus 校验）。

### 7.17 通讯录与日历：把人解析成 id，把时间当成含末日的区间

这两块看起来是「多加几个端点」，实际难的都是**平台自己的表示法**：通讯录的 HTTP 与 CLI 回的是两个不同结构，日历的全天事件是「含末日进、排他存」。

**`contact.resolve`：一个名字，两个字段。**

参数只有 `query`（上限 50 字符，超了在起进程前拒）与可选的 `pageSize`（上限 30，平台的 `page_size` 也封顶）。没有做 `queries` 多名扇出：合并成一次结果后，「这个名字解析成了谁」就看不见了——同名、错别字、只命中英文名这几种情况正是要人眼确认的地方。

平台的差异在返回体上：CLI 的 `+search-user` 直接给 `data.users[]`（`open_id` / `localized_name` / `email` / `p2p_chat_id` / `has_chatted` / `is_cross_tenant` / `match_segments`），HTTP 的 `POST /open-apis/contact/v3/users/search` 给 `data.items[]`，每项是 `{id, display_info, meta_data:{chat_id, i18n_names, mail_address, is_cross_tenant}}`——**同一个 `open_id` 在两边的键名不同**（`open_id` vs `id`），名字也不同源（`localized_name` vs `i18n_names` 首串 vs `display_info` 里带 HTML 高亮的片段）。

所以归一放在一处：`open_id` 取 `open_id || id`，`name` 按 `localized_name → i18n_names 首串 → 去掉高亮标签的 display_info` 逐级回落。**`p2p_chat_id` 是这块真正的产出**：它正是 `im.send` 需要的 `chatId`，于是「查人 → 发消息」不再需要手工从客户端里抄一个 `oc_…`。真机 `query:"wing"` 与 `query:"魏宁"` 都命中同一个 `ou_c4a8906ed54269eeaf460027b5795cf0`（中文名匹配、英文名显示），`has_chatted:true`、`p2p_chat_id` 与我自己的私聊 id 一致。HTTP 侧第一次探测吃过一次 `504 hijack proxy request failed`，重试即 200——这类是代理层抖动，不是平台错，所以按常规 5xx 重试处理即可。

**`calendar.agenda`：时间窗口是一次实例展开，不是一次分页。**

`GET /calendar/v4/calendars/{id}/events/instance_view`，`calendar_id` 直接用字面量 `primary`（不必先解析真实 id；真实 id `feishu.cn_WcLRtdxItFHZzDoZTBH9Rd@group.calendar.feishu.cn` 只在需要精确指定时才有意义）。默认窗口是「今天起一天」，按配置时区（默认 `Asia/Shanghai`）算，`from`/`to` 接受三种写法：epoch 秒、ISO 8601、`YYYY-MM-DD`（按 +08:00 零点）。`to` 必须晚于 `from`，否则在发请求前拒——平台的空窗口就是空数组，不报错，所以这条得自己拦。

**全天事件：平台按「含末日」接收，按「排他结束」存储。**

这是本批最反直觉的一条，实测两个例子：输入 `28→28` 被存成 `28→29`，输入 `28→29` 被存成 `28→30`。也就是说 `end_time.date` 是**排他**的，而人对「28 到 29 两天」的理解是**含末日**的。于是：

- 写：`allDay` 时参数里的 `end` 按含末日理解，发出去的 date 是它**加一天**；`start`/`end` 允许同一天（表示一天）。
- 读：`all_day` 判据是「`start_time.date` 存在」，输出的 `end` **减一天**后按「00:00:00 起、含末日 23:59:59 止」呈现。

如果照抄平台，调用方就会看到「28 号的一日会议」变成「28–29」；如果只在输出端修正，写进去的又会被平台多算一天。两头都改，语义才对得上。

**cli 路线做不出真全天事件。** `lark-cli calendar +create --start 2026-11-28 --end 2026-11-29` 会把两个日期算成时间戳（`end` 是当日 `23:59:59`），于是平台上落成一条 **00:00:00–23:59:59 的定时事件**，不是全天事件。这不是参数没传对，是 CLI 的参数形态决定的。处理方式有两层：

1. `normalizeEvent` 读回时按存储判定，所以 `agenda` 会如实说这条是 `all_day:false`（真机验证：用 cli 建 allDay 后读回确实是 `00:00:00 → 23:59:59`、`all_day:false`）。
2. `calendar.create` 的形状**按结果而不是按请求**报 `all_day`：一开始它按参数回 `true`，那就是撒谎；现在改成「`start` 里出现 `T\d{2}:\d{2}` 就判 false」，并在这种情况下附一句 `notice`：`lark-cli creates an all-day request as a timed 00:00:00-23:59:59 event; the oauth route stores a real all-day event`。

也就是说：**`allDay` 在 oauth 路线是真全天，在 cli 路线是「整天的定时块」**，调用方从 `all_day` 和 `notice` 就能看出自己拿到的是哪一种，不需要记路线。

**`calendar.create`：建事件与邀请是两次请求，失败了要能退回去。**

cli 侧一次 `calendar +create` 就够（`attendees` 它会自己补第二个请求，失败时自动删掉刚建的事件）。oauth 侧得自己走两步：`POST .../events` 拿 `event_id`，再 `POST .../events/{id}/attendees?user_id_type=open_id`。第二步失败时**回滚**——删掉刚建的事件，否则日历里会留一条「没人收到邀请」的会议。错误文案要分开两种情况：删成功了说「已删除、没有发出邀请」，删也失败就说「事件仍存在」，并带上 id 让人能手工清。

`attendees` 只接受 `open_id`（`ou_…`）与 `chat_id`（`oc_…`）两种，其余形态在发请求前拒——邀请一个人和一个群是平台的两条分支，猜错就是把邀请发给不存在的对象。`notify:false` 在 cli 是 `--notify=false`，在 oauth 是 attendees 请求里的 `need_notification`。

**cli 建事件会顺手带几样东西，oauth 只在你说的时候才带。** 实测 CLI 每次都会写 `vchat:{vc_type:"vc"}`（即每次建会都挂一个视频会议）、`reminders:[{minutes:5}]`、`description_rich:"（由豆包工作创建）"`、`attendee_ability:"can_modify_event"`。oauth 侧的 `POST events` 只发 `{summary, description?, start_time, end_time}` 就能 200。这与 7.15 那条文字后缀是同一类差异：**平台侧多出来的东西属于 CLI 的人格，不属于我们的动作语义**。文档记下来，代码不模拟——模拟等于把 CLI 的私货变成两条路线的公共契约。`rrule`（重复事件）与 `location` 这批没做：CLI 有 `--rrule` 没有 location 参数，而 `recurrence` 只在探针里验证过一次（`FREQ=DAILY;COUNT=2` 被接受），没系统测过展开与例外，不做半成品。

**`calendar.delete`：永久的，所以 risk 恒 high。**

与 `drive.delete` 同一规矩：没有 `allow:["high"]` 就静默拒绝。真机验证过这条门确实拦得住——`me` 实例的 `allow` 是 `["read","write"]`，`calendar.delete` 直接回 `lark: risk "high" is not allowed for this instance (allowed: read, write)`。清理探针事件时临时给了临时实例 `high` 才删掉。

删除要处理重复事件：`apply_to` 取 `single` / `all` / `this-and-following`，默认 `single`（删一次实例而不是整个序列——这是更小的一步）。CLI 侧还有一道自己的确认，`--yes` 必须显式带上：**风险门已经在前面问过了，再让 CLI 在脚本里弹一次确认只会挂住进程**，所以 `calendarDeleteArgs` 无条件加 `--yes`。`notify:false` 在 cli 是 `--notify=false`，在 oauth 是 `need_notification=false`。

**oauth 路线的真机首跑（M16 补完，Personal Edition 自建应用 + 一次真人授权）**

授权走通了，也顺手暴露了三件只有真机才会告诉人的事：

1. **`contact.resolve` 的 scope 写错了**。`contact:user.base:readonly` 只能读「自己的基本信息」，搜索用户要的是 **`contact:user:search`**。错配的表现是 HTTP 200 之外的一个 `99991679`：「required one of these privileges under the user identity: [contact:user:search]」。已把动作的 scope 改成 `contact:user:search`，应用侧权限、`user/proxies.json` 的 scope 表、测试里的 scope 一起对齐。这条正是 scope 门存在的意义：cli 路线因为 CLI 自己的 token 权限更宽而一直没暴露。
2. **`open_id` 是按应用隔离的**。同一个魏宁，cli 路线的 `ou_c4a8906ed54269eeaf460027b5795cf0` 与本应用拿到的 `ou_434a658837ec837621f0052ccb96bbaa` 是两个值——`p2p_chat_id`（`oc_8283fef6…`）反而两边一致。所以「邀请参会人」必须用**同一个应用**解析出来的 `open_id`：拿 cli 的 open_id 去 oauth 建邀请，平台回 `open_id cross app`。这条同时解释了为什么 `contact.resolve` 的产出应当和 `im.send` 出自同一实例。
3. **参会人失败的回滚是真跑过的**：先用跨应用的 open_id 建邀请，平台拒了之后，消息原样是「the created event … was deleted again, so no invitation went out」。这不是测试断言，是线上的一次失败把代码走到了那个分支。

修好之后再跑一遍，四个动作端到端：

- `contact.resolve {query:"wing"}` → `ou_434a…` / 魏宁 / `p2p_chat_id oc_8283fef6…`，`cross_tenant:false`；
- `calendar.create` 定时 → `efd6ed94-…`，`10:00:00 → 10:20:00 +08:00`，带 `app_link`；
- `calendar.create` 带 `attendees:[ou_434a…]`（`notify:false`）→ `50da5232-…`，返回 `attendees:[{open_id, name:"wing", type:"user", rsvp:"accept"}]`；
- `calendar.create allDay 11-28 → 11-29` → `all_day:true`、`start:"2026-11-28"`、`end:"2026-11-29"`——**这才是真全天**，和 cli 路线的 00:00:00–23:59:59 定时块形成对照，而且没有 `notice`；
- `calendar.agenda {11-27 → 11-30}` → 三条，全天那条读回仍是 `all_day:true` 与两个日期；
- 三条 `calendar.delete {notify:false}` 都回 `deleted:true`，之后同窗口里 M16 前缀剩 0。

**全天事件的 `timezone` 不该有值。** 平台给 date 形式的 `start_time` 也塞了一个 `timezone:"UTC"`，第一版照抄，于是「11-28 一天」被标上了 UTC。日期没有时区，现在的归一在 `all_day` 时**不输出 `timezone` 字段**（定时事件照旧给 `+08:00` 这类偏移），调用方不会看到一条「UTC 的全天会议」。

**授权这一步的真实摩擦（给下次省时间）**：应用建在 **Feishu Personal Edition** 租户里，Personal Edition 的权限申请**即时开通、免审核**，但每加一项权限都要**重新走一次同意**（增量授权页只列新增的那一项）；回调地址必须先在「安全设置 → 重定向 URL」里逐字登记，否则授权页直接 `20029`；应用没发布版本时，授权页会报 `你没有…的使用权限`，这与「scope 不够」是两种完全不同的错误。`offline_access` 已在授权里拿到，`user/oauth/me-oauth.json`（0600）存了 refresh token，之后刷新链自持。

**真机证据（cli 路线，经 proxy）**：`calendar.create` 定时 `2026-11-27 09:00–09:20` → `event_id 07488810-…`，`agenda {from:"2026-11-27"}` 读回一条、时间一致；`calendar.create allDay 11-28→11-29` → `all_day:false` + `notice`，`agenda` 读回 `00:00:00 → 23:59:59`；两条 `calendar.delete {notify:false}` 都回 `deleted:true`、`apply_to:"single"`，之后 `agenda` 里 M16 前缀事件剩 0 条。oauth 路线的形状由 5 条假平台测试锁定（contact 的 `items[]` 归一、`instance_view` 参数与时区、create 两请求与 attendees body、attendees 失败回滚、allDay 的 date 形态 + delete 的 `need_notification`/`apply_to`），**真机 oauth 端到端这一轮没跑**：手上没有有效的 user access token（刷新链路需要重新走一次授权），留待下次带着 token 补。

