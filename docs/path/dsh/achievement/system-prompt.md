# 系统提示词（实现层）

对应原型：`../prototype/system-prompt.md` 与 `../prototype/runtime-context.md`。

## 当前实现

### 组装入口与时机

- 组装函数：`core/system-prompt.js` 的 `assembleSystemPrompt()`。
- 组装时机：`assemble-system` 节点（`core/loops/nodes/assemble-system/run.js`）在 turn 的第一个 step 调用一次；**会话已有系统提示词时直接复用数据库里的那一份**，不再重新组装。
- 落库时机：`model-call` 节点在 `r === 0` 时，如果系统提示词是新的，就把 `role="system"` 的消息写进数据库（`core/loops/nodes/model-call/run.js`）。
- bare 分支（`core/bare-chat.js`）每次请求都重新组装，不落库。

### 段落

| 段落 | order | 来源 |
|---|---|---|
| `harness:identity` | -1000 | `user/settings.json` 的 `identity`，缺省 `You are an AI agent.` |
| `deployment:persona` | 0 | `user/settings.json` 的 `persona`，缺省为空 |
| `harness:language` | 500 | 固定 `Always answer in English.` |
| `tool:<name>` | 1000+ | 工具 `registry.json` 的 `prompt` 字段 |
| `runtime:context` | 10000 | 自动生成的四行运行时上下文 |

只有本轮可见的工具才贡献 `tool:*` 段落。工具有 `promptSection` 时多个工具共用一段，`{{tools}}` 被替换成可见工具名以 ` or ` 连接。

### 运行时上下文

`core/system-prompt.js` 的 `buildRuntimeContext()` 固定输出四行：

```text
Current working directory: "<cwd>".
Current time: <ISO 8601> (<timezone>).
Current model: <model>.
Platform: <platform> (<arch>).
```

它作为 `runtime:context` 段落（order 10000）拼在系统提示词末尾，**不是**独立的 user 消息。

### 渲染

- section 按 `order` 升序，同 order 按 `name` 码元序。
- `{{name}}` 严格插值：未注册的变量抛错。
- 空文本段落丢弃，段落间以空行连接。
- 已注册变量：`cwd`、`model`。

### 技能目录

`renderSkillCatalog()` 在首轮把技能清单渲染为一条 **user 消息**，紧跟在 system 消息之后，落库顺序为 system → 技能目录 → user。

## 与原型的关系

### 已对齐

- 段落按 order 升序、同 order 按名字码元序（`core/system-prompt.js`）。
- `{{var}}` 严格插值，未知变量抛错。
- 空段落丢弃、段落间以空行连接。
- 工具指引按 DSH 固定表排序（bash 1000、read 1100…goal 2400）。
- 技能目录以 user 消息发布，只在首轮出现。
- 系统提示词只在会话首轮组装一次，之后复用 —— 对应原型 sdk-minimal 的 `includeHarnessIdentity: false` 与 standard 预设的 persona 思路。

### 实现差异（已决定）

- **系统提示词在数据库里只存一份**，之后所有轮次复用。原型每个候选 step 都重新组装，并按 `systemPromptUpdate` 模式决定追加还是原地替换；我们选择了"会话首轮冻结"。
- **运行时上下文是系统提示词的一段**（order 10000），原型是独立的 user 角色快照。我们的 cwd/时间/模型/平台在会话内冻结，原型每次准入前刷新。
- **`harness:language` 是固定英文策略**（`Always answer in English.`），原型没有这个段落，语言策略由 persona 与翻译功能承担。
- **`deployment:persona` 不是可遮蔽的槽位**：我们是单段拼接，原型用 `deployment:persona-prefix` / `deployment:persona-suffix` 两个命名槽位配合作用域遮蔽。
- **没有 `complete` 与 `suppressRuntimeContext` 机制**。

### 待对齐

- 段落的**作用域遮蔽**：原型按 agent 作用域注册与遮蔽，我们只有全局一份。
- **`refreshContext` 式刷新**：原型准入前只刷新 context 提供者；我们没有任何刷新入口。
- **运行时上下文改为独立 user 消息**（原型 `runtime-context.md` 的帧模板）。

### 未实现

- `plan:policy`、`team:policy`、`context:file-reference`、`harness:source`、`app:web-surface`、`mcp:*` 等段落 —— 原型里有，我们目前都没实现（其中计划态策略见下一条）。
- 计划态策略：我们有 `core/plan-mode.js` 的 `POLICY` 常量，但它是在请求时**拼在系统提示词后面**，而不是注册为 order 500 的段落。属于"部分实现、形态不同"。
- 工作区指令（`AGENTS.md` 注入）完全未实现；`core/skills/filesystem.js` 里的 `PROJECT_AGENTS`/`USER_AGENTS` 是**技能目录来源**的排序常量，不是工作区指令。
- 变量只有 `cwd` 与 `model`；原型由 agent-loop 注册 `provider` / `model`。

### 明确不做

- `complete: true` 的单段覆盖机制 —— 我们的段落集合固定，没有部署替换完整系统提示词的需求。

### 我们独有

- `runtime:context` 段落把 cwd/时间/模型/平台拼成四行写进系统提示词，影响见 `additional/`（暂无独立文档）。

## 后续计划

1. 把运行时上下文从段落改为独立 user 消息，并接入帧模板（对应 `prototype/runtime-context.md`）。
2. 把 `plan-mode` 的 POLICY 从"请求时拼接"改为注册为 `plan:policy` 段落，order 500。
3. 补工作区指令注入（`AGENTS.md`），参考 `prototype/agent-instructions.md` 的基线/增量形态。
4. 段落的 agent 作用域遮蔽按需引入，当前单 agent 场景优先级低。
