# spec

本文件是项目顶层设计的唯一权威，定义功能模块、模块接口与全局命名。三层结构（core / transport / UI）是分层约定；模块在编译期解耦、运行时经注册表接合。代码标识符一律英文。

## 1 功能树

按「能力域 → 功能模块」两级组织。每个末端节点是一个模块，也是独立完成与替换的封装单元；模块名同时作为第 2 章契约条目的标题。

```
foundation 基础与接入
  layered-architecture        三层分层与 createCore 组合根
  transport-registry          传输注册表 + http / ipc
  rpc                         命令注册表与处理器组
  permission-gate             三级工具权限门
  fs-path-policy              写类工具的路径级策略
  workspace                   会话工作目录解析
  electron-ui                 Electron 外壳与 preload 桥

runtime 运行时
  agent-runtime               turn 状态与模式分派
  bare-chat                   无持久化对话
  agent-mode                  presence / autonomy / activity 三轴
  loop-registry               引擎与节点注册表
  loop-node-graph             图执行引擎（活跃）
  loop-linear                 线性引擎（冻结参考）
  loop-nodes                  turn-start / assemble-system / assemble-input /
                              resolve-target / pre-step / model-call /
                              tool-execute / decide-next 八节点
  plan-mode                   计划态与请求级策略注入
  goals-and-todos             goal 状态机与 turn 内 todo 投影

model 模型通信
  provider-config             provider / model / baseurl 解析
  model-service               reasoning 参数映射与流式入口
  model-request               payload 构造与 HTTP 请求
  response-process            SSE / JSON 读取与用量累计
  stream-render               增量到 UI 事件的渲染
  model-catalog               /models 拉取、能力与上下文窗口
  net-track                   网络请求抓包与脱敏

context 上下文
  system-prompt               system prompt 组装与节排序
  text-assemble               有序文本管线拼装器（DSL 驱动、操作可插拔）
  context-service             上下文门面（压缩 / 锚点 / 输入 / cwd / 翻译）
  compaction-core             压缩纯函数（边界 / 检查点 / 溢出判定 / 估算）
  compaction-runner           压缩编排（surface / summarize / prune / 压力触发）
  token-meter                 用量归一化与 token 估算
  token-anchor                每请求 token 锚点
  auto-translate              中英输入 / 输出翻译
  references                  @ 文件与历史会话引用注入
  context-overflow-recovery   溢出时剪枝 / 摘要并重试

tools-core 工具内核
  directory-tool-registry     目录扫描加载 registry.json
  tool-execution-pipeline     参数校验 / 执行 / 结果整形
  tool-schema                 工具参数 JSON Schema 校验
  tool-result                 结果文本化 / 截尾 / spill
  tool-service                工具选择 / 定义 / 目录投影
  fs-observe                  read-before-write 与版本 CAS

tools-fs 文件与命令工具
  tool-read                   带行号读取与观察记录
  tool-write                  新建或整体替换
  tool-edit                   字面串替换
  tool-glob                   路径发现
  tool-grep                   内容检索
  tool-bash                   shell 命令执行与命令门

tools-web 网络工具
  tool-web-search             Tavily 搜索聚合
  tool-web-fetch              URL 到有界 markdown
  tool-lib                    ripgrep / web 共享实现库

tools-state 交互与状态工具
  tool-ask-user-question      挂起等待用户选择
  tool-request-user-job       委派真实任务给人类
  tool-job-output             user job 结果 / 状态
  tool-job-list               会话 user job 列表
  tool-job-kill               取消 pending user job
  tool-create-goal            新建会话目标
  tool-get-goal               读取当前目标
  tool-update-goal            目标状态机变更
  tool-todo-write             替换任务清单
  tool-exit-plan-mode         计划审阅与批准
  tool-calculator             算术求值（默认隐藏）
  tool-get-current-time       ISO8601 时钟（默认隐藏）

interaction 交互服务
  interaction-service         审批 / 问答 / 计划审阅 / user job 的挂起与恢复

skills 技能
  skill-registry              注册 / 收集 / 快照 / 变更通知
  skill-provider              文件系统技能来源
  skill-content               技能内容渲染与转义
  skill-policy                model / user 可调用性判定
  tool-skill                  技能调用工具

subagent 子代理
  subagent-runtime            派生 / 寻址 / 投递 / 收割
  tool-subagent               委派子任务
  tool-subagent-fork          从会话边界派生子代理
  tool-send-message           向子代理发消息
  tool-interrupt-agent        中断子代理
  tool-list-agents            列出会话子代理

storage 存储
  store                       事件溯源存储与 store.run 操作面
  storage-schema              表结构定义
  session-projection          surface / history 回放投影
  session-fork                会话派生

quality 质量
  test-suite                  node --test 测试集
```

## 2 模块契约表

每个模块钉死三项：职责边界（负责 / 不负责）、接口签名、命名。签名中的类型名为语义标注，不代表运行时类型检查。

### 2.1 foundation 基础与接入

**layered-architecture**
- 职责：负责组合根与分层边界——`createCore()` 装配各服务并暴露 `core` 对象；launcher 选择 UI、启动 transport。不负责任何业务逻辑。
- 接口：`createCore(): Core`；`Core.chat(ctx): Promise<void>`；`Core.handleCall(name, params, meta): any`；`launcher` 按 `AGENT_UI` / `AGENT_TRANSPORT` 选择实现。
- 命名：组合根函数 `createCore`；运行时类 `AgentRuntime`；环境变量 `AGENT_*`。

**transport-registry**
- 职责：负责 core 与 UI 的通信抽象——注册并按 `AGENT_TRANSPORT` 启动一个传输实现。不负责消息内容。
- 接口：`registry.register(name, factory)`；`startTransport(name, core, opts): Transport`；`DEFAULT = "http"`；`createHttpTransport(core, opts)` / `createIpcTransport(core, opts)` 返回 `{ send(event), onCall(handler), close() }`。
- 命名：工厂 `create<Name>Transport`；默认常量 `DEFAULT`。

**rpc**
- 职责：负责把 channel 请求路由到服务——统一命令注册表 + 五组处理器（chat / config / catalog / interactions / storage）。不负责业务实现，只做参数校验与转发。
- 接口：`createRpc(): RpcRegistry`；`RpcRegistry.define({ name, params, handler, streaming? })`；`RpcRegistry.dispatch(name, params, meta)`；`EMPTY_PARAMS`。命令名：
  ```
  chat.send            chat.compact
  config.get           config.set
  fs.read
  models.fetch         models.capabilities      models.contextWindow
  interactions.approve interactions.answerQuestions
  interactions.answerPlanReview                  interactions.answerUserJob
  tools.list           skills.list  skills.get
  loops.list  loops.get  loops.upsert
  plan.get   plan.set
  ```
- 命名：命令名 `<domain>.<verb>`（点分、小写）；处理器文件 `handlers/<domain>.js` 导出 `define<Domain>Commands(rpc)`。

**permission-gate**
- 职责：负责工具级 allow / ask / deny 判定，配置损坏或缺失时 fail-closed 到 `ask`。不负责路径细分（归 `fs-path-policy`）与挂起交互（归 `interaction-service`）。
- 接口：`readPermissions(): Permissions`；`permissionFor(toolName, permissions): "allow" | "ask" | "deny"`；`PERMISSIONS_FILE`。
- 命名：档位字面量 `allow` / `ask` / `deny`；配置文件 `permissions.json`。

**fs-path-policy**
- 职责：负责 write / edit 的路径级允许范围——deny 优先、首条匹配生效、坏文件忽略。不负责工具级权限。
- 接口：`readFsPolicy(): FsPolicy`；`resolveFsPermission(filePath, policy): "allow" | "ask" | "deny"`；`FS_POLICY_FILE`。
- 命名：配置文件 `fs-policy.json`；匹配辅助 `_matches` / `_globToRegExp`。

**workspace**
- 职责：负责从会话记录解析工具 cwd，相对路径按 cwd / home / parent 试探，失败回退 `process.cwd()`。不负责 cwd 下的文件操作。
- 接口：`isDirectory(p): boolean`；`workspaceFolderCandidates(raw): string[]`；`resolveWorkspaceFolder(raw): string | null`。
- 命名：解析函数 `resolveWorkspaceFolder`。

**electron-ui**
- 职责：负责桌面外壳与渲染进程桥——创建 BrowserWindow、preload 暴露受限 API。不负责界面渲染（归 `web-ui-shell`）。
- 接口：`launcher` 按 `AGENT_UI=electron` 启动；preload 暴露 `window.<bridge>` 供 `ui/web` 调用 transport。
- 命名：入口 `main.js` / `preload.js`；桥对象 camelCase。

### 2.2 runtime 运行时

**agent-runtime**
- 职责：负责进程级 turn 状态与模式分派——`chat` 按 `ctx.mode==="bare"` 分到 bare-chat，否则选 loop 引擎。不读配置、不暴露 RPC、不持有审批表。
- 接口：`AgentRuntime` 构造 `({ config, model, context, tools, skills, interactions, store, goals })`；`setCore(core)`；`setSubagents(factory)`；`services(): Services`；`beginTurn({ emit, autonomy })`；`chat(ctx): Promise<void>`；`compactSession(opts)`。
- 命名：类 `AgentRuntime`；turn 字段 `autonomy` / `effort` / `activity` / `bootId`。

**bare-chat**
- 职责：负责无持久化对话——内存历史、强制空工具集、不落库，但保留翻译与 turn 事件契约。不负责会话模式。
- 接口：`runBareChat(core, ctx): Promise<void>`。
- 命名：函数 `runBareChat`；模式信号 `ctx.mode === "bare"`。

**agent-mode**
- 职责：负责三轴状态语义——presence（in/out）、autonomy（supervised/autonomous）、activity（九值枚举）。不负责各轴的实现机制（plan-mode 等各自模块）。
- 接口：autonomy 判定 `isAutonomous(): boolean`；activity 由 `activity` 字段携带，plan-mode 由 activity 派生。
- 命名：枚举值小写连字符，如 `plan-mode` / `build-code` / `human-learn`。

**loop-registry**
- 职责：负责引擎与节点注册——按 `AGENT_LOOP_ENGINE` 选引擎，扫描 `nodes/` 与 `builtins/` 载入节点定义。不负责执行。
- 接口：`getLoop(name?): LoopEngine`；`listEngineNames(): string[]`；`DEFAULT_ENGINE`；`loadNodes(): Map<nodeId, Node>`；`NODES_DIR` / `BUILTINS_DIR`。
- 命名：节点目录 kebab-case（如 `assemble-system/`）；引擎名 `node-graph` / `linear`。

**loop-node-graph**
- 职责：负责图执行——按节点 `next` 指针驱动 turn/step，维护 `ctx` 传递。不负责单节点逻辑。
- 接口：`runLoop(core, ctx): Promise<void>`；`NodeGraphEngine`。
- 命名：类 `<Name>Engine`；执行入口统一 `runLoop`。

**loop-linear**
- 职责：线性执行引擎，冻结为参考实现，不随默认路径演进。
- 接口：`runLoop(core, ctx): Promise<void>`。
- 命名：与图引擎共用 `runLoop` 入口，靠注册表区分。

**loop-nodes**
- 职责：八个步骤节点各自封装单一职责：turn-start（turn 初始化）、assemble-system（system prompt）、assemble-input（输入投影）、resolve-target（provider/model 解析）、pre-step（plan/todo/压缩门）、model-call（请求与落 step）、tool-execute（审批与执行）、decide-next（终止判定）。节点不跨职责。
- 接口：`run(input, ctx) → { output, next?, done? }`；每节点含 `registry.json`（id / next / prompt 等）+ `run.js`。
- 命名：节点 id kebab-case；文件固定 `registry.json` + `run.js`。

**plan-mode**
- 职责：负责计划态——请求级 POLICY 注入，不改已存 system prompt、不写库；批准经 `applyPendingExit` 在下一步移除。不负责审批 UI。
- 接口：`POLICY`；`isActive(sessionId)`；`setActive(sessionId, active)`；`recordHeader(sessionId, active)`；`requestExit(sessionId)`；`applyPendingExit(sessionId)`；`hasPendingExit(sessionId)`；`getLastHeaderActive(sessionId)`。
- 命名：策略常量 `POLICY`；pending 退出用 `requestExit` / `applyPendingExit` 成对。

**goals-and-todos**
- 职责：负责会话级目标状态机（CAS 由 revision 控制）与 turn 内 todo 投影。不负责自动续轮驱动。
- 接口：`createGoalService()` → `{ create, get, update }`；`goalValue()`；`DEFAULT_MAX_ROUNDS`；todo：`reset()` / `get()` / `set(todos)`。
- 命名：目标动作字面量 `edit` / `pause` / `resume` / `complete` / `blocked`；并发字段 `revision`。

### 2.3 model 模型通信

**provider-config**
- 职责：负责从 `providers.json` / `settings.json` 解析 provider、model、baseurl、apikey 与上下文窗口。不负责发起请求。
- 接口：`readSettings()` / `writeSettings()`；`readProviders()` / `writeProviders()`；`findProvider(name)`；`enabledModels(provider)`；`resolveProvider(opts)`；`resolveTarget({ provider, model })`；`resolveDefaultFromProviders()`；`resolveContextWindow(opts)`；`reasoningParamFor(baseUrl)`；路径常量 `USER_DIR` / `SETTINGS_FILE` / `PROVIDERS_FILE` 等。
- 命名：解析函数 `resolve*`；配置文件 `<name>.json`；字段 camelCase（对外）与 snake_case（落库）。

**model-service**
- 职责：负责 reasoning 参数映射与流式 / 能力入口，持有 provider 配置引用。不负责 payload 构造细节。
- 接口：`ModelService` 构造 `({ config })`；`reasoningParamFor(baseUrl)`；`stream(opts)`；`emitUsage(onEvent, raw)`；`fetchModels(baseurl, apikey)`；`capabilities({ provider, model })`。
- 命名：类 `<Name>Service`；能力方法 `capabilities`。

**model-request**
- 职责：负责构造 chat payload（含 effort 翻译）并发出 HTTP 请求。不负责读取响应流。
- 接口：`buildPayload(opts): object`；`issueRequest(opts): Promise<Response>`。
- 命名：纯构造函数 `build*`；网络动作 `issueRequest`。

**response-process**
- 职责：负责读取 SSE / JSON 响应、累积 tool_calls 与 usage。不负责渲染为 UI 事件。
- 接口：`stream(opts): AsyncIterator<Delta>`；`emitUsage(onEvent, raw): Usage`。
- 命名：流函数 `stream`；用量 `Usage`。

**stream-render**
- 职责：负责把增量 delta 渲染为 UI 事件（token / reasoning / tool_call / usage）。不负责模型请求。
- 接口：`renderDelta(delta, onEvent): void`。
- 命名：渲染函数 `renderDelta`。

**model-catalog**
- 职责：负责模型清单、能力探测与上下文窗口查询，供 RPC 调用。不负责模型选择落库。
- 接口：经 RPC `models.fetch` / `models.capabilities` / `models.contextWindow` 暴露；底层 `fetchModels(baseurl, apikey)`。
- 命名：命令 `<domain>.<verb>`；能力字段 `capabilities`。

**net-track**
- 职责：负责把所有 chat/completions 与 /models 请求旁路写入结构与原始抓取文件，敏感头脱敏。不参与请求成败。
- 接口：`trackCapture(opts)`；`recordCapture(...)`；`redactHeaders(headers)`；`expandBody(...)`；`ENABLED` / `QUIET`。
- 命名：开关 `NETTRACK` / `NETTRACK_QUIET`；抓取目录 `log/network/track/`。

### 2.4 context 上下文

**system-prompt**
- 职责：负责按固定节序组装 system prompt，按可见工具注入对应 prompt 段。不负责会话持久化。
- 接口：`assembleSystemPrompt(opts): string`；`SystemPrompt`；`renderSkillCatalog(opts)`；`buildRuntimeContext(opts)`；`SECTION_ORDERS`；`DEFAULT_IDENTITY`；`ENGLISH_ONLY_INSTRUCTION`；`localIso()`。
- 命名：节序表 `SECTION_ORDERS`；组装函数 `assemble*`。

**text-assemble**
- 职责：通用有序文本管线——把文本列表按受限 DSL 描述的操作序列依次变换，输出拼装后的文本。SystemPrompt 是其消费方之一，负责 prompt 特有的 section 与变量；本模块只做管线执行，不执行任意代码、不持有可变状态、不负责 prompt 语义。
- 接口：`assemble(items, dsl, params) → string`；`items` 为有序文本段列表，`dsl` 为以 `|` 分隔操作名的字符串（如 `sort|dedupe|join`），`params` 为传给各操作的参数。`OPERATIONS` 为固定白名单表，条目形态 `(list, params) → list`；`join` 作为其中一步，连接符固定为 `\n\n`。未知操作名报错而不静默忽略，不提供 `eval` / `Function` 等动态执行入口。
- 扩展：新增一种操作 = 在 `OPERATIONS` 白名单登记一个 `(list, params) → list` 函数并在 DSL 中引用其名；白名单是模块级固定表（非可变注册表），故 `assemble` 保持纯函数。
- 命名：函数 camelCase（`assemble`）；DSL 操作名小写、以 `|` 分隔，与第 3 章命名一致；白名单常量 SCREAMING_SNAKE（`OPERATIONS`）。

**context-service**
- 职责：上下文门面，聚合压缩、锚点、输入准备、消息清洗与 cwd 解析供节点调用。不持有 turn 状态。
- 接口：`ContextService` 构造 `({ config, model, tools, skills, store })`；`setRuntime(runtime)`；`assembleSystem(opts)`；`prepareInput(opts)`；`surfaceNodes(sessionId)`；`requestMessages(sessionId, system, pending)`；`summarizeMessages(opts)`；`pruneToolResults(sessionId)`；`runCompaction(opts)`；`compactSession(opts)`；`maybeCompactStep(opts)`；`recordTokenAnchor(opts)`；`resolveContextWindow(opts)`；`cleanMessage(msg)`；`resolveCwd(sessionId)`；translate 转发四方法。
- 命名：门面方法名与被聚合模块同名，便于定位。

**compaction-core**
- 职责：负责压缩的纯计算——token 估算、边界选择、检查点封装、溢出判定、剪枝。不访问 store、不发请求。
- 接口：`estimateTextTokens` / `estimateMessageTokens` / `estimateMessagesTokens` / `estimateToolsTokens`；`codePointLength`；`pruneToolResultText`；`frameCheckpoint`；`checkpointMessage`；`isContextOverflowError`；`surfaceCuts`；`selectAutoBoundary`；`selectTailBoundary`；阈值常量 `AUTO_THRESHOLD_RATIO` / `AUTO_RETAIN_RATIO` / `PRUNE_THRESHOLD_CHARS` 等。
- 命名：估算 `estimate*Tokens`；选择 `select*Boundary`；常量 SCREAMING_SNAKE。

**compaction-runner**
- 职责：负责压缩编排——surface / requestMessages / summarize / prune / runCompaction / 压力触发，经回调取运行时能力，只向上发 `compaction` 事件。不 import 组合根。
- 接口：`surfaceNodes` / `requestMessages` / `summarizeMessages` / `pruneToolResults` / `runCompaction` / `compactSession` / `maybeCompactStep`，均 `(deps, ...args)` 形态。
- 命名：编排函数与模块同名；依赖集中为 `deps` 参数。

**token-meter**
- 职责：负责 provider 用量归一化（含缓存 token）、token 估算与锚点构造。不负责落库。
- 接口：`normalizeUsage(raw)`；`measure(...)`；`anchorFrom(...)`；`estimateHeaderTokens(...)`；`headerKey(...)`。
- 命名：归一化 `normalize*`；锚点构造 `anchorFrom`。

**token-anchor**
- 职责：负责把用量锚点写入会话，仅依赖 token-meter。不负责压缩。
- 接口：`recordTokenAnchor(deps, opts): Promise<void>`。
- 命名：记录函数 `recordTokenAnchor`。

**auto-translate**
- 职责：负责中文输入译英、英文输出译中（仅显示、不落库），输入 / 输出失败策略与超时独立。不负责流式渲染。
- 接口：`resolveConfig(settings)`；`shouldTranslateUser(text, config)`；`shouldTranslateAssistant(text, config)`；`translateText(opts)`；`buildPayload` / `cleanTranslation`；`hasHan` / `hasProse`；`DEFAULT_CONFIG`。
- 命名：判定 `shouldTranslate*`；配置解析 `resolveConfig`。

**references**
- 职责：负责把 UI 引用解析为上下文块——本地文件（限大小）或历史会话轨迹摘录，插入到问题之前。不负责文件写入。
- 接口：`resolveReferences(deps, refs): Promise<Block[]>`；`prepareUserInput(deps, opts)`。
- 命名：解析函数 `resolveReferences` / `prepareUserInput`。

**context-overflow-recovery**
- 职责：负责模型请求溢出时触发剪枝 / 摘要并重试一次。不负责常规压缩调度。
- 接口：`maybeCompactStep({ trigger: "context-overflow" })`；`isContextOverflowError(err)`。
- 命名：触发字面量 `context-overflow`。

### 2.5 tools-core 工具内核

**directory-tool-registry**
- 职责：负责扫描 `tools/*/registry.json` 并加载 `run`，收集 name / description / parameters / type / prompt / timeoutMs / defaultVisible。不负责执行。
- 接口：`loadTools(): Map<name, ToolDef>`；`TOOLS_DIR`。
- 命名：目录名即工具名 snake_case；清单文件固定 `registry.json`。

**tool-execution-pipeline**
- 职责：负责工具调用的参数校验、审批前错误返回、执行与错误归一。不负责结果渲染。
- 接口：`validateToolArgs(def, args)`；`runTool(def, args, ctx): Promise<Result>`。
- 命名：校验 `validateToolArgs`；执行 `runTool`。

**tool-schema**
- 职责：负责工具参数的 JSON Schema 校验，错误文案对齐既有格式。不负责业务参数语义。
- 接口：`validateSchema(schema, value): void`（失败抛错）。
- 命名：校验函数 `validateSchema`。

**tool-result**
- 职责：负责把工具结果整形为模型可见文本 + 仅 UI/DB 可见的 meta，统一错误为 `Error: <message>`，超长截尾并 spill 到文件。不负责执行。
- 接口：`normalizeResult(raw)`；`errorResult(message)`；`truncate(text, limits)`；spill 落 `tmp/tool-output/`。
- 命名：错误前缀 `Error: `；meta 字段 snake_case。

**tool-service**
- 职责：负责对注册表做确定性选择与投影——`select` / `defs` / `list` / `listFunctions`。不负责加载与执行。
- 接口：`ToolService` 构造 `(tools)`；`select(toolNames?)`；`defs(tools)`；`list()`；`listFunctions()`；`get/keys/values/entries/size`。
- 命名：类 `<Name>Service`；选择按 name 排序保证确定性。

**fs-observe**
- 职责：负责 read-before-write / edit 的观察记录与版本 CAS。不负责文件读写本身。
- 接口：`record(path)`；`assertVersion(path)`；`versionOf(path)`；`reset()`。
- 命名：版本键 `mtime:size`；断言函数 `assertVersion`。

### 2.6 tools-fs 文件与命令工具

每个工具对外统一为 `run(args, ctx) → { text, meta }`，参数由各自 `registry.json.parameters` 声明。下表给出各自参数要点与专属约束。

- **tool-read**：`file_path, offset?, limit?`；返回带行号内容；记录观察；2000 行 / 2000 字符 / 50KB 上限，10MB 流式，NUL 判二进制。
- **tool-write**：`file_path, content`；建父目录、原子写；先观察且版本一致，否则拒绝。
- **tool-edit**：`file_path, old_string, new_string, replace_all?`；唯一匹配或 `replace_all`；先观察、拒陈旧版本、CRLF 归一化。
- **tool-glob**：`pattern, path?`；包含 hidden/ignored；100 条上限 + spill；`concurrencySafe`，30s 超时。
- **tool-grep**：`pattern, path?, include?`；`rg --json`；250 匹配上限 + spill；`concurrencySafe`，30s 超时。
- **tool-bash**：`description, command, timeoutMs?, workdir?`；fresh `bash -c`；120s 默认 / 600s 上限；每流 64KB 截尾 + spill；命令门来自 `bash-policy.json`；不实现 sandbox、不做后台 job。

### 2.7 tools-web 网络工具

- **tool-web-search**：`queries`；Tavily 合并至多四查询，返回来源 URL；结果标记为不可信，建议随后 web_fetch；30s 超时、`concurrencySafe`。
- **tool-web-fetch**：`url`；抓单个 HTTP(S) URL 转有界 markdown（turndown）；返回 `statusCode` / `truncated`；30s 超时、`concurrencySafe`。
- **tool-lib**：共享实现库——`ripgrep.js` 供 glob/grep；`web/` 下 config / transport / network / policy / trust / tavily / search / render 供 web 工具。不暴露为模型工具。

### 2.8 tools-state 交互与状态工具

- **tool-ask-user-question**：`questions`；挂起等待 UI 提交，自主模式直接解析；返回 `{"answers":[...]}`。
- **tool-request-user-job**：`description, title?`；挂起等待人类报告，返回报告与 `job_id`。
- **tool-job-output**：`job_id`；读取 user job 结果 / 状态；需活跃会话。
- **tool-job-list**：无参数；列出本会话 user job（job_id / status / 描述摘要）。
- **tool-job-kill**：`job_id`；取消 pending job，完成或已取消的只报状态。
- **tool-create-goal**：`objective, max_goal_rounds?`；新建会话目标。
- **tool-get-goal**：无参数；读取当前目标（含 id / revision）。
- **tool-update-goal**：`goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?`；按 revision CAS 做状态变更。
- **tool-todo-write**：`todos`；整表替换，turn 开始重置。
- **tool-exit-plan-mode**：`plan`；仅 plan 模式可用；批准退出，拒绝返回反馈并保持 plan。
- **tool-calculator**：`expression`；正则白名单求值；`defaultVisible: false`。
- **tool-get-current-time**：无参数；`Date().toISOString()`；`defaultVisible: false`。

### 2.9 interaction 交互服务

**interaction-service**
- 职责：负责所有挂起型交互的生命周期——审批、问答、计划审阅、user job 的请求 / 应答 / 取消；自主模式下 ask 类请求自动拒绝。不负责 UI 呈现。
- 接口：`InteractionService` 构造 `({ store, emit, autonomy })`；`beginTurn({ emit, autonomy })`；`isAutonomous()`；`requestApproval({ callId, name, args, permission })`；`approve(id, decision)`；`requestUserQuestion` / `answerQuestions`；`requestPlanReview` / `answerPlanReview`；`requestUserJob` / `answerUserJob` / `killUserJob`。
- 命名：请求 `request<X>`、应答 `answer<X>` 成对；事件 `*-request` / `*-update`。

### 2.10 skills 技能

**skill-registry**
- 职责：负责技能注册、收集、快照与缓存失效 / 变更通知。不负责技能文件读取（归 provider）。
- 接口：`SkillRegistry` 构造 `(opts)`；`registerProvider(factory)`；`register(skill)`；`collect(options)`；`collectFresh(options)`；`list(options)`；`snapshot(options)`；`get(name, options)`；`onSkillsChange(cb)`；`invalidateCache()`；`notifyChange()`；`RUNTIME_RANK` / `RUNTIME_PROVIDER`。
- 命名：类 `<Name>Registry`；收集 `collect*`；快照 `snapshot`。

**skill-provider**
- 职责：负责从文件系统读取技能定义。不负责注册决策。
- 接口：`FileSystemSkillProvider`；`createFileSystemProvider(config, deps)`。
- 命名：来源类 `<Source>SkillProvider`；工厂 `create<Source>Provider`。

**skill-content**
- 职责：负责技能内容的转义与资源提示渲染。不负责技能选择。
- 接口：`escapeText` / `escapeAttr`；`renderResourceHint`；`renderSkillContent`。
- 命名：渲染 `render*`；转义 `escape*`。

**skill-policy**
- 职责：负责判定技能是否可被模型 / 用户调用。不负责加载。
- 接口：`isModelInvocable(skill)`；`isUserInvocable(skill)`。
- 命名：判定 `is<Subject>Invocable`。

**tool-skill**
- 职责：负责把技能作为工具暴露给模型调用。
- 接口：`run(args, ctx) → { text, meta }`，参数由 `registry.json` 声明。
- 命名：工具名 `skill`。

### 2.11 subagent 子代理

**subagent-runtime**
- 职责：负责子代理派生、命名分配、寻址、消息投递、中断与收割结算；生命周期从属于调用它的 agent，不构成团队。不负责界面树呈现。
- 接口：`SubagentRuntime` 构造 `(core, deps)`；`spawn(spec)` / `spawnFork(spec)`；`resolveAgent(callerSessionId, agent)`；`sendMessage({ senderSessionId, agent, message })`；`interruptAgent({ callerSessionId, agent })`；`listAgents({ callerSessionId })`；`isRunning(sessionId)`；`pathOf` / `rootOf`；`drain()`；`takeSteering(sessionId)`；结算辅助 `settlementSummary` / `buildSettlementText` / `limitDiagnostic` / `mapStopReason`；常量 `SUBAGENT_DELEGATION_CONTEXT` / `ROOT_AGENT_NAME` / `AGENT_NAME_PATTERN`。
- 命名：类 `<Name>Runtime`；派生 `spawn*`；结算 `settlement*` / `buildSettlementText`。

- **tool-subagent**：`run(args, ctx)`；委派独立上下文子任务，单轮完成即终止。
- **tool-subagent-fork**：`run(args, ctx)`；从会话边界派生子代理。
- **tool-send-message**：`run(args, ctx)`；向子代理投递消息。
- **tool-interrupt-agent**：`run(args, ctx)`；中断子代理。
- **tool-list-agents**：`run(args, ctx)`；列出会话内子代理。

### 2.12 storage 存储

**store**
- 职责：负责事件溯源存储——log 行只追加不改写，模型可见历史为回放投影；提供统一 `store.run(op, params)` 操作面。不负责业务判定。
- 接口：`Store` 构造 `(db)`；`run(op, params)`；`close()`。操作面按实体点分：
  ```
  session.create/get/list/update/delete/restore/surface/history/prompt/compactions
  turn.create/get/list/update/delete     step.create/get/list/update/delete
  message.add/get/list/delete            call.add/get/list/update/delete
  content.add/get                        workspace.create/get/list/update/delete
  goal.get/save                          token-anchor → saveTokenAnchor/getTokenAnchor
  compaction.start/succeed/fail/active   tool_result_prunes → saveToolResultPrune
  userJob → createUserJob/getUserJob/listUserJobs/completeUserJob/killUserJob
  subagent.add/get/list/discard          skill.create/get/list/update/delete
  model.create/get/list/update/delete    provider.create/get/list/update/delete
  tool.create/get/list/update/delete
  ```
- 命名：操作名 `<entity>.<verb>`（点分、小写）；实体方法 camelCase（`createSession` 等）。

**storage-schema**
- 职责：负责表结构定义。不负责数据读写。
- 接口：DDL 常量；表：`workspaces / sessions / session_forks / session_seq_counters / turns / steps / calls / messages / contents / compactions / tool_result_prunes / token_anchors / goals / user_jobs / subagents / subagent_prompts / subagent_settles / skills / tool_skills / tools / providers / models`。
- 命名：表名与列名 snake_case；改列按约定直接重建库文件，不做迁移。

**session-projection**
- 职责：负责把 log 行回放为 surface / history 投影。不负责写入。
- 接口：`getSurface({ session_id })`；`getSessionHistory({ session_id })`；`_projectMessages` / `_hist` / `_ownSurfaceNodes` / `_checkpointNode`。
- 命名：投影函数 `get<View>`；内部辅助下划线前缀。

**session-fork**
- 职责：负责从历史边界派生新会话，原会话保留。不负责子代理派生（归 subagent-runtime）。
- 接口：`addSessionFork({ child_session_id, parent_session_id, parent_boundary_seq })`；`getSessionFork` / `listSessionForks` / `deleteSessionFork`；`getForkBoundary({ session_id })`。
- 命名：实体 `session_fork`；边界字段 `parent_boundary_seq`。

### 2.13 quality 质量

**test-suite**
- 职责：负责覆盖工具、bash 集成与压缩的自动化测试，不依赖 Electron 启动。
- 接口：`node --test test/*.test.js`；文件 `tools.test.js` / `bash-integration.test.js` / `compaction.test.js`。
- 命名：测试文件 `*.test.js`；用例描述英文。

## 3 命名规范

### 3.1 模块名

- 能力域目录用小写单数：`foundation` / `runtime` / `model` / `context` / `tools-core` / `tools-fs` / `tools-web` / `tools-state` / `interaction` / `skills` / `subagent` / `storage` / `quality`。
- 模块名小写连字符：`tool-execution-pipeline` / `token-anchor` / `permission-gate`。
- 工具模块以 `tool-` 前缀 + 工具名：`tool-read` / `tool-subagent-fork`。
- 文件名固定约定：`registry.json`（声明）+ `run.js`（实现）；入口 `index.js`；测试 `*.test.js`。

### 3.2 路径

- core 服务：`core/<domain>/index.js` 或 `core/<domain>.js`。
- 循环节点：`core/loops/nodes/<node-id>/{registry.json,run.js}`；内建节点：`core/loops/builtins/<node-id>/`。
- 工具：`tools/<tool_name>/{registry.json,run.js}`；共享实现 `tools/lib/`。
- 配置与数据：`user/*.json`（进程级）；`data/store.db`；抓取 `log/network/track/`；溢出 `tmp/tool-output/`。

### 3.3 接口

- 函数 camelCase、动词开头：`resolveTarget` / `assembleSystemPrompt` / `recordTokenAnchor`。
- 纯构造用 `build*` / `normalize*`；判定用 `is*` / `should*` / `has*`；请求 / 应答用 `request<X>` / `answer<X>` 成对。
- 类 PascalCase，按角色后缀 `<Name>Service`（无状态服务）/ `<Name>Runtime`（运行时）/ `<Name>Registry`（注册表）/ `<Name>Engine`（引擎）/ `<Name>Provider`（来源）。
- 组合根 `createCore`；工厂 `create<Name>Transport` / `create<Source>Provider`。
- 常量 SCREAMING_SNAKE：`DEFAULT_ENGINE` / `POLICY` / `SECTION_ORDERS`。
- 内部辅助以下划线前缀：`_projectMessages` / `_matches`。

### 3.4 信号

事件经 `emit({ type, ... })` 发送，`type` 一律小写连字符：

```
approval-request   ask-user-question   compaction    core          done
error              model-http-status   plan-mode     plan-review   result
session            skill               step-start    system-prompt tool_call
tool_result        translation         turn-end      usage         user-job-request
user-job-update
```

- 请求 / 响应语义：`*-request` 表示挂起等待，`*-update` 表示状态刷新。
- 工具相关保留既有下划线形态 `tool_call` / `tool_result`，其余用连字符。

### 3.5 数据

- 表名 / 列名 snake_case；主键 `id`，外键 `<entity>_id`（如 `session_id` / `turn_id`），时间列 `created_at` / `updated_at`。
- store 操作名 `<entity>.<verb>`（小写点分）：`session.create` / `message.add` / `compaction.succeed`。
- RPC 命令名 `<domain>.<verb>`：与 store 操作共用点分风格，靠前缀区分域。
- 模型可见工具结果字段 snake_case；UI/DB 专用字段收在 `meta` 下，不进入模型上下文。
- 配置文件 camelCase 字段（对外），落库时映射为 snake_case。

## 4 接口归属规则

改动按接口归属决定落点：改一个模块的接口，只改定义该接口的模块；调用方依赖接口签名而非实现，接口不变则调用方不改。

- **接口变更**：签名、参数结构、返回结构或错误语义变化时，改定义方模块及其 `registry.json` / 声明文件。调用方只有在签名实际改变时才同步，且只改对调用点的适配，不复制被调方逻辑。
- **实现变更**：签名不变、只换内部算法或数据来源时，只改该模块实现，调用方零改动。
- **跨域改动**：一个需求同时触及多个模块接口时，先拆成多次单模块改动，每次只落一处；不允许把跨域逻辑塞进调用方或新建协调模块来绕开归属。
- **新增功能**：优先新增独立模块并挂到注册表；只有确实改变既有接口时才动既有模块，且遵守上述接口变更规则。

## 5 插槽规范

插槽是一类可互换实现：同类实例遵循统一契约，新增一个只需按约定放入目录或文件，不改扫描器与消费者。判据是**同类是否存在两个以上、且接口能归一的实现**——满足则做成插槽，单实现模块保持普通模块、手写装配。

当前已落地的插槽分两类：完全插槽（放入即生效）与半插槽（需改一处注册表或入口）。

### 5.1 完全插槽

**tools**
- 契约：目录 `tools/<name>/`；`registry.json` 声明 `name / description / parameters / type / prompt / promptSection / timeoutMs / concurrencySafe / defaultVisible / result / entry`；入口 `run.js` 导出 `run(args, ctx) → { text, meta }`（或 `default.run`）。
- 扫描：`loadTools()` 扫 `tools/*/registry.json`，无 registry 的目录（如 `tools/lib/`）跳过；校验 name 非空、entry 不越界、run 为函数；失败逐个跳过并记录，不影响其他工具。
- 扩展：新建 `tools/<name>/` 放入上述两文件即被加载，无需改动扫描器或调用方。

**loop nodes**
- 契约：目录 `core/loops/nodes/<node-id>/`；`registry.json` + `run.js` 导出 `run(input, ctx) → { output, next?, done? }`。
- 扫描：`loadNodes()` 扫 `nodes/*/registry.json`；builtin 节点走同一加载器、`type` 标 `builtin`。
- 扩展：新建节点目录即被载入并经 `next` 指针接入图。

**loop builtins**
- 契约：目录 `core/loops/builtins/<node-id>/`，接口同 loop nodes。
- 扫描：与 loop nodes 一并加载，不占默认 `next` 链，由引擎按需调用。
- 扩展：新建 builtin 目录即生效。

**loop engines**
- 契约：目录型 `core/loops/<name>/index.js` 或文件型 `core/loops/<name>.js`，导出 `runLoop(core, ctx)`。
- 扫描：`listEngineNames()` 扫目录与 `.js` 文件，排除 `nodes` / `builtins` / `registry` / `shared` / `loops-config`；`getLoop(name)` 加载，未知或非默认失败回落 `DEFAULT_ENGINE`（`node-graph`）。
- 扩展：放入一个导出 `runLoop` 的目录或文件即被列举与加载，经 `AGENT_LOOP_ENGINE` 选中。

**skills**
- 契约：来源根目录下 `<name>/SKILL.md`（目录包）或 `<name>.md`（单文件）；frontmatter 声明 `name / description / whenToUse? / disable-model-invocation / user-invocable / metadata`，正文为技能内容。
- 扫描：`FileSystemSkillProvider.discoverRoot()` 扫各 root（项目 `.agents/skills` / `.dsh/skills`、customSkillDirs、user、bundled）；校验 name 合法、frontmatter 完整；`watch` 开启时监听目录变更触发缓存失效。
- 分层：skill *内容* 是完全插槽（放目录即加载）；skill *provider 来源* 通过 `SkillRegistry.registerProvider(factory)` 注册，当前只注册 FileSystemSkillProvider 一个。
- 扩展：往任一 root 放入符合契约的目录或文件即被加载，无需改代码。

### 5.2 半插槽

**transports**
- 契约：文件型，工厂 `create<Name>Transport()` 返回带 `start(core)` 的传输实例。
- 现状：`core/transport.js` 手写 `registry = { http, ipc }`，新增传输需在该注册表加一行；`startTransport` 按 `AGENT_TRANSPORT` 选，未知回落 `http`。
- 与完全插槽的差距：未扫描目录、注册集中在入口文件。

**rpc handlers**
- 契约：文件型，`core/rpc/handlers/<domain>.js` 导出 `define<Domain>Commands(rpc)`，内部用 `rpc.define({ name, params, handler, streaming? })` 注册命令。
- 现状：`createRpc()` 硬编码调用各组 define 函数，新增一组需在入口加一行。
- 与完全插槽的差距：未扫描目录、注册集中在入口文件。

### 5.3 provider：当前非插槽

provider 目前不是插槽——差异未归一为代码契约，而是压成配置字段：`providers.json` 是数据数组，`findProvider` / `resolveProvider` 按 name / base_url 查表；`reasoningParamFor(baseUrl)` 按 base_url 取 `reasoning_param` 字段；`buildPayload` 用同一套 OpenAI 兼容格式给所有 provider 构造请求，无 provider 专属代码模块或目录扫描。因此放入一个 provider 文件不会被加载。

成为文件型插槽的前提是先归一契约（如 payload 构造 / 响应解析 / 能力映射 / effort 翻译各自的接口），这属于新规范设计，不在当前固化范围；此处记录其非插槽状态，为后续扩展留定位。
