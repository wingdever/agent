# skill 子系统

> 本规格以本机安装的 `@deepseek-ai/dsh@0.2.1-rc.2` 的 skill 能力族为实现参照。
> 文中所有面向模型的模板、文案、参数与默认值均逐字取自该版本编译产物
> `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem`、
> `@deepseek-ai/dsh-tool-skill`、`@deepseek-ai/dsh-api-session-controller`
> 的 `lib/` 与 `lib/types/`。引用路径写成 `<包名>/lib/...:行号`，均指 0.2.1-rc.2。
> 本项目采用同一套面向模型的模板与门控；目录在会话起始生成一次、会话内不变。工程差异集中在末尾「取舍」。

## 1. 组成与落点

### 1.1 dsh 的三段职责

skill 能力族拆成「注册表 / 提供方 / 消费方」三段，注册表本身不读磁盘：

- Service Definition `dsh-skill`：注册 `ctx.skills`（`SkillRegistry`），合并各提供方的目录，裁决重名，按需加载正文，不关心 skill 从哪来。
- 本地提供方 `dsh-skill-filesystem`：扫描根目录、解析 `SKILL.md` frontmatter、加载正文，通过 `ctx.skills.registerProvider()` 挂进注册表。
- 消费方 `dsh-tool-skill`：声明 `inject: ["agents", "tools", "skills", "workingDirectory"]`（`dsh-tool-skill/lib/index.js:762`），注册面向模型的 `skill` 工具，并在每个模型步骤前维护会话 skill 目录。
- 附带 seam `ctx.sessionSkillCatalog`：浏览器侧读取 Session 的用户可调用目录，不激活 Agent。

模型看到的只有两样东西：一条会话里的 skill 目录消息，和一个 `skill` 工具。正文从不提前进入上下文，只在工具调用（或用户显式手势）后以 `<skill_content>` 块出现。

### 1.2 本项目落点

| dsh | 本项目 |
|---|---|
| `ctx.skills`（`SkillRegistry`） | `core/skills/registry.js`：`list(cwd)` / `snapshot(cwd)` / `get(name, cwd)` / `registerProvider()` / `register()` |
| `dsh-skill-filesystem` | `core/skills/filesystem.js`：根扫描、frontmatter 解析、失效通知 |
| `dsh-tool-skill` | `tools/skill/registry.json` + `tools/skill/run.js` |
| `renderSkillContent` / `escapeText` | `core/skills/content.js`：共享渲染，`tools/skill` 与 `type:"skill"` 引用共同依赖 |
| 目录消息渲染 | `core/system-prompt.js`：会话起始生成的多消息块 |
| `agent/pre-step` waterfall | 会话起始装配点：`core/loops/nodes/assemble-system/run.js` 与 `core/loops/linear.js:139-142` |
| 用户主动注入技能（引用块） | `core/user-input/user-references.js` 的 `resolveReferences` 的 `type:"skill"` 分支：进入引用上下文消息 |
| `ctx.sessionSkillCatalog` | UI 侧 `skills.list` IPC |
| `skills` / `tool_skills` 表 | `core/storage/schema.mjs:48`（存储层已有骨架） |

## 2. 数据模型

### 2.1 名称与调用策略

skill 名称是 kebab-case，正则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。目录消息里的条目、工具参数、frontmatter 的 `name` 都按 `isSkillName()` 校验。

调用策略是**两个独立正向布尔**，避免把任意 frontmatter 带进领域模型：

```ts
interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}
```

`isModelInvocable()` / `isUserInvocable()` 只是读这两个字段（`dsh-skill/lib/index.js:37-47`）。四种组合都合法：两者皆真是常规 skill；`modelInvocable: false` 且 `userInvocable: true` 的 skill 只能由用户 `/name` 手势加载；两者皆假的 skill 仅受信的 `ctx.skills.get()` 调用方能取到。

### 2.2 摘要、候选项与完整定义

```ts
type SkillSource =
  | 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh'
  | 'user-agents' | 'custom' | 'bundled' | (string & {})

type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

interface SkillSummary {
  readonly path?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: SkillSource
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
}

interface SkillCandidate extends SkillSummary {
  readonly rank: number
  readonly locator: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
}

interface SkillDefinition extends SkillSummary {
  readonly content: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  readonly invocation?: SkillInvocationPolicy
  readonly provider?: string
}
```

`SkillSummary` 与调用策略无关，消费方自行决定渲染哪些条目。**模型会话目录只使用 `name` 和 `description`，从不使用正文、路径、来源或提供方**（`dsh-skill/lib/types/index.d.ts:47-61`）。`SkillCandidate.locator` 是提供方的不透明句柄，注册表存下来并在 `get()` 时原样传回。`SkillDefinition.content` 是去掉 frontmatter 后的 Markdown 正文。

### 2.3 查找选项与快照

```ts
interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

interface SkillViewOptions extends SkillLookupOptions {
  readonly scope?: ScopeKey | undefined
}

interface SkillCatalogSnapshot {
  readonly skills: SkillSummary[]
  readonly complete: boolean
}

interface SkillProvider {
  readonly name: string
  readonly list: (options: SkillLookupOptions) =>
    Promise<readonly SkillCandidate[] | SkillProviderObservation>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) =>
    Promise<SkillDefinition | undefined>
}

interface SkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}
```

`cwd` 决定工作区相关的根目录，`signal` 取消发现与加载。注册表 API 为 `registerProvider()` / `register()` / `list()` / `snapshot()` / `get()`（`dsh-skill/lib/types/index.d.ts:247-284`）。**注册表不缓存完整定义**：每次 `get()` 都让胜出提供方重读当前正文，因此只改正文不会改变目录，只会改变后续工具调用的结果。发现期间目录持续变化时，观察结果标为 `complete: false` 且不缓存，消费方保留上一份可用视图。

`dsh-skill` 的注册表配置只有 `collectCacheMaxEntries`（默认 128）；`dsh-tool-skill` 只有 `catalogDescriptionMaxLength`（默认 500，整数最小 3）；文件系统根目录、watcher 等配置归提供方所有。

## 3. 本地发现

### 3.1 目录优先级

`dsh-skill-filesystem` 按 rank 扫描根目录，rank 小者在同一层内优先（同名 skill 取 rank 最小者）：

| rank | source | 根目录 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `bundledSkillDir` = 项目根 `<root>/skills`（`BUNDLED_SKILL_RANK = 600`，当前为空） |

常量在 `dsh-skill-filesystem/lib/index.js:20-24` 与 `dsh-skill/lib/index.js:23`。`projectRoot` 是含 `.git` 的最近祖先，找不到时用 cwd。运行时 `register()` 贡献的 skill 用 `RUNTIME_RANK = 250`（`dsh-skill/lib/index.js:21`）。本项目按 `docs/roadmap.md:155` 复用 `~/.agents/skills/<name>/SKILL.md` 的 `name` / `description` frontmatter 格式，根目录表按本项目配置收敛，rank 相对顺序保持一致。

### 3.2 SKILL.md 格式

本地提供方接受两种形态：目录包 `<name>/SKILL.md` 与扁平 `<name>.md`；不支持递归 `**/SKILL.md`。frontmatter 用 YAML 解析，`name` / `description` 缺失、名称不合法或 YAML 损坏的文件被忽略，正文为 `parsed.body.trim()`（`dsh-skill-filesystem/lib/index.js:685-706`）。

| 字段 | 类型 | 处理 |
|---|---|---|
| `name` | string，必填 | 必须满足 `isSkillName()`，否则文件被忽略 |
| `description` | string，必填 | 进入模型目录，经规范化与截断 |
| `whenToUse` | string，可选 | 额外路由提示；**不进入模型目录** |
| `disable-model-invocation` | boolean，可选 | `true` → `modelInvocable: false` |
| `user-invocable` | boolean，可选 | `false` → `userInvocable: false` |
| `metadata` | object，可选 | 提供方自用的不透明元数据 |

策略规范化（`dsh-skill-filesystem/lib/index.js:852-857`）：

```js
rejectLegacyInvocationKey(data, "disableModelInvocation", "disable-model-invocation");
rejectLegacyInvocationKey(data, "modelInvocable", "disable-model-invocation");
rejectLegacyInvocationKey(data, "userInvocable", "user-invocable");
const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
const userInvocable = frontmatterBoolean(data, "user-invocable");
// => { modelInvocable: disableModelInvocation !== true,
//      userInvocable: userInvocable !== false }
```

两个字段缺省都放行（既模型可调也用户可调）。旧式驼峰键一律报错，避免静默误判。`frontmatterBoolean()` 接受布尔、`1`/`0`、以及 `true/yes/on` 与 `false/no/off` 字符串。

文件系统提供方给每个加载结果附 `resourceBase: { kind: "directory", path: locator.directory }`（`dsh-skill-filesystem/lib/index.js:125-130`），并保留 `path` 与 `metadata`。

### 3.3 失效与重发现

提供方持有注册作用域内的 `SkillProviderControl.signal` 与 `invalidate()`；仅当该精确注册仍存活时 `invalidate()` 才清除已完成目录。watcher 监视根目录内直属 bundle 与扁平条目的增删、以及直属 skill 条目的变更；`write` / `edit` 观察命中相关路径时同步使目录失效。任何变更发出不带 diff 的 `skills/change` emit 事件，消费方用自己的查找选项重新 `snapshot()`。watcher 失败只让当前观察不完整，不隐藏仍可直接加载的候选项。

本项目的目录在会话起始取一次快照，`skills/change` 不影响当前会话；新建会话时重新发现。

## 4. 与模型的通信契约

本节记录 dsh 的通信契约，是本项目实现的参照基线。契约有两条方向和一道门控：

- dsh → 模型：会话历史里的一条持久 user-role `<system-reminder>` 消息，内含 `<available_skills>` 目录。
- 模型 → dsh → 模型：模型调用 `skill({ name })` 工具，工具结果回灌为 `<skill_content>` 块。
- 门控：`isModelInvocable` 决定哪些 skill 进目录、哪些能被工具加载；`isUserInvocable` 决定哪些能被用户 `/name` 手势加载。

目录消息是会话事件：消费方从 `agent.session` 的事件序列倒序读取 `user/message`（`dsh-tool-skill/lib/index.js:1062-1074`），随历史回放，不进 system prompt，也不属于请求时的工具清单。

本章描述 dsh 的完整行为。本项目采用其中首次目录模板、条目渲染、`skill` 工具定义与结果模板、`/name` 手势语义；替换目录、digest 去重与压缩后重建属于会话内变更机制，不在本项目实现范围。

### 4.1 方向一：首次 skill 目录消息

`dsh-tool-skill` 在会话中第一次观察到非空完整目录时，通过 `createUserMessage()` 注入一条 user 消息（`dsh-tool-skill/lib/index.js:966-989`）。消息体逐字为：

```
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

消息携带持久 source，供非模型消费方直接读取条目，不必解析 `<available_skills>` 文本（`dsh-tool-skill/lib/types/index.d.ts`）：

```ts
interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  readonly update?: true
  readonly entries: readonly { readonly name: string; readonly description: string }[]
}
```

### 4.2 方向一：替换目录消息

目录发生变化时，注入一条同样形态、但声明「完整替换」的消息（`dsh-tool-skill/lib/index.js:990-1014`），`source.update` 置为 `true`：

```
<system-reminder>
The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:

<available_skills>
- `<name>`: <description>
</available_skills>

<availability lines>
</system-reminder>
```

`<availability lines>` 按目录是否为空二选一：

```
No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.
A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.
```

```
Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
```

删除全部 skill 仍会追加一条显式空替换，让模型不再引用旧目录里的名字。目录消息不会因 skill 正文修改而改变 —— 正文不进目录。

### 4.3 方向一：条目渲染、转义与截断

```js
// dsh-tool-skill/lib/index.js:1021-1023
function renderCatalogEntries(entries) {
  return entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`);
}
```

```js
// dsh-tool-skill/lib/index.js:1087-1090
function catalogDescription(value, maxLength) {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
```

`escapeText()` 把 `&`、`<`、`>` 转成实体，防止 description 里的伪 XML 打开或闭合框架标签（`dsh-skill/lib/index.js:91-93`）。`name` 通过 `isSkillName()` 校验，不含需转义字符。`catalogDescriptionMaxLength` 默认 500、最小 3（`dsh-tool-skill/lib/index.js:768,777`）。摘要按名称排序，目录只含 `name` 与规范化后的 `description`。

### 4.4 方向一：注入时机与 digest

该插件注册两个 `agent/pre-step` waterfall 监听器（`dsh-tool-skill/lib/index.js:896,931`）：前者处理用户 `/name` 手势，后者维护目录。目录监听器在每个模型步骤前：

1. 用**精确定义同一性**判断工具可见性：`ctx.tools.get(skillTool.name, agent) === skillTool`。工具被限制或被同名 scope 影子遮蔽时，`snapshot` 退化为 `{ skills: [], complete: true }`，目录与调用指引一并消失。
2. 取 `snapshot({ cwd, signal, scope: agent })`，用 `isModelInvocable` 过滤，得到有序条目。
3. 对条目计算 digest，与会话中最后一条**仍可见**的目录消息比较。digest 逐字为（`dsh-tool-skill/lib/index.js:1029-1032`）：

```js
const canonical = entries.map((entry) => JSON.stringify([entry.name, entry.description])).join("\n");
return createHash("sha256").update(canonical).digest("hex");
```

4. digest 未变：不重新发布，并把本步骤里重复出现的目录消息从待发 messages 中移除。digest 变化：本步骤 messages 里已有目录消息时原位替换，否则追加一条；会话里从未发布过目录时用首次目录模板，之后一律用声明完整替换的 `update: true` 模板。
5. `complete: false` 的快照保留上一份可用视图，不发布。压缩隐藏了所有历史目录消息后，下一份完整快照重新建立当前目录；视图为空且从未发布过目录时不发送任何消息。

`catalogHistory()` 从会话事件倒序扫描 `kind === 'skill-catalog'` 的 user/message，用 `surface.nodes` 判定可见性，并容忍来源记录不可读（续跑、forked 或外部写入的 seed），不会因此让后续所有轮次失败（`dsh-tool-skill/lib/index.js:1059-1076`）。

### 4.5 方向二：skill 工具定义

`dsh-tool-skill` 用 `defineTool()` 注册并 `ctx.tools.register(skillTool)`（`dsh-tool-skill/lib/index.js:787-895`）：

```js
{
  name: "skill",
  description: "Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.",
  parameters: {
    name: {
      type: "string",
      required: true,
      description: "The exact skill name from the available skills list."
    }
  },
  output: {
    schema: { /* object: name, provider, resourceBase?, content; additionalProperties: false */ },
    render: (_args, value) => [{ type: "text", text: renderSkillContent(value) }]
  },
  presentCall(args) {
    return { card: "generic", title: `Load skill ${args.name}`, kind: "read", rawInput: args.name }
  }
}
```

`output.schema` 的 `resourceBase` 是 `directory` / `url` / `opaque` 三选一的 `oneOf`，各分支字段与 `SkillResourceBase` 一致。

### 4.6 方向二：执行流程与错误文案

```js
// dsh-tool-skill/lib/index.js:866-885
async execute(args, exec) {
  if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`);
  const lookup = {
    cwd: exec.agent === void 0 ? void 0 : await ctx.workingDirectory.ensure(exec.agent, exec.signal),
    signal: exec.signal,
    scope: exec.agent
  };
  const summary = (await ctx.skills.list(lookup)).find((skill) => skill.name === args.name);
  if (!summary) throw new Error(`skill "${args.name}" is unknown or no longer available`);
  if (!isModelInvocable(summary)) throw new Error(`skill "${args.name}" is not available for model invocation`);
  const skill = await ctx.skills.get(args.name, lookup);
  if (!skill) throw new Error(`skill "${args.name}" is unknown or no longer available`);
  if (!isModelInvocable(skill)) throw new Error(`skill "${args.name}" is not available for model invocation`);
  return {
    name: skill.name,
    provider: skill.provider,
    ...skill.resourceBase !== void 0 ? { resourceBase: { ...skill.resourceBase } } : {},
    content: skill.content
  };
}
```

`cwd` 来自 `ctx.workingDirectory.ensure(agent, signal)`；`scope` 是调用方 agent 本身，因此按该 agent 的分层注册表解析。策略在「摘要查找」与「加载完整定义」两处各校验一次，防止发现期间策略被改。错误文案逐字为上述 `Error: ...` 串；本项目的工具执行器统一把异常渲染成 `Error: <message>`（`core/tools/result.js:12-14`），模型看到的文本因此一致。

### 4.7 方向二：工具结果模板

`renderSkillContent()` 生成唯一规范的模型可见块，工具结果与用户手势注入共用同一函数（`dsh-skill/lib/index.js:57-70`）：

```
<skill_content name="<escaped name>">
<skill_resources>
<resource hint lines>
</skill_resources>

<skill_instructions>
<skill.content>
</skill_instructions>
</skill_content>
```

`name` 走 `escapeAttr()`（`&` → `&amp;`、`"` → `&quot;`、`<` → `&lt;`）；正文按原样嵌入，不加转义 —— skill 是可信本地内容，用户输入文本不进入这个包装。`renderResourceHint()` 按 `resourceBase` 分四种（`dsh-skill/lib/index.js:71-81`）：

```
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

```
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

```
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

```
Resources for this skill: <description>
Load referenced resources only as needed.
```

`resourceBase` 只用于按需解析 skill 正文里显式引用的脚本、参考资料与资产；加载结果**不枚举 skill 目录**。因此只改正文会改变后续工具结果，不会生成新的目录消息，也不会改写先前已落库的工具结果。

### 4.8 用户直接调用：/name 手势

用户显式调用走另一条入口，与 `skill` 工具无关（`dsh-tool-skill/lib/index.js:896-930`）。手势识别逐字为：

```js
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
```

只扫描 `source.kind === "user"` 的消息文本块（外部文本不能伪造手势），按首次出现顺序去重。对每个名字 `ctx.skills.get(name, lookup)`，仅当 `isUserInvocable(skill)` 为真时，注入一条 `createUserMessage()`，内容同样是 `renderSkillContent(skill)`，source 为：

```ts
interface SkillInvocationSource {
  readonly kind: 'skill-invocation'
  readonly name: string
  readonly form: 'instructions'
}
```

注入消息追加在所有其它注入之后（背景材料在前、模型要执行的材料最靠近回答）。这是 `disable-model-invocation` skill 的**唯一**入口：目录和 `skill` 工具都看不到它们。目录消息里对此有明确指引，模型见到 `<skill_content>` 后不得再为该 skill 调用 `skill` 工具。

### 4.9 门控汇总

| 入口 | 过滤 | 模型可见内容 |
|---|---|---|
| 会话 skill 目录 | `isModelInvocable` | `<available_skills>` 里的 `name` + 规范化 `description` |
| `skill` 工具 | `isModelInvocable`（两次） | `<skill_content>` 完整正文 |
| 用户 `/name` 手势 | `isUserInvocable` | 同一 `<skill_content>` 模板，作为注入的 user 消息 |
| 浏览器 Session 目录 | `isUserInvocable` | 名称、描述、`whenToUse`、`modelInvocable` |

### 4.10 浏览器 Session 目录

`ctx.sessionSkillCatalog` 是 Session 寻址的 Remote seam，不激活冷 Agent 即可读取 Session 的 cwd 与记录的 preset（`dsh-api-session-controller/lib/types/skill-catalog.d.ts`）。类型逐字为（`dsh-api-session-controller/lib/types/types.d.ts:246-265`）：

```ts
interface SkillListRequest { readonly sessionId: SessionId }

interface SkillEntry {
  readonly path?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

interface SkillListValue { readonly skills: readonly SkillEntry[] }
```

`@Remote async list(request, signal)` 的实现从注册表取 `list({ cwd, scope })` 后用 `isUserInvocable` 过滤，映射出 `name` / `description` / `whenToUse` / `modelInvocable`（`dsh-api-session-controller/lib/types/skill-catalog.js:162-169`），不加载正文。`modelInvocable` 只是带出的标记，不参与过滤。live Agent 用其 scope registry，冷 Session 用 preset 的 standing scope。

### 4.11 端到端时序

下列为 dsh 的完整时序；本项目的会话内不发生目录变更，对应地不含第 5 步。

1. 会话开始，skill 提供方完成发现，`snapshot()` 给出完整目录。
2. 首个模型步骤前，注入持久 user-role 的首次 `<system-reminder>` 目录消息（带 `skill-catalog` source）。
3. 模型读到目录，判断任务匹配某 skill，调用 `skill({ name })`。
4. 工具经策略校验与正文加载，结果以 `<skill_content>` 块作为 tool result 回灌会话。
5. 模型按 `<skill_instructions>` 执行；期间若目录变化，下一模型步骤前追加声明完整替换的目录消息。
6. 用户直接输入 `/name` 时，走用户手势注入，把同一模板的 `<skill_content>` 作为注入的 user 消息放进上下文，模型不再调用工具。

## 5. 本项目实现规格

### 5.1 模块划分

`core/skills/` 内三个模块各管一段：`registry.js`（合并、重名裁决、`get()` 重读正文）、`filesystem.js`（根扫描、frontmatter、失效通知）、`content.js`（`renderSkillContent`、`escapeText`、`escapeAttr`、资源提示）。`content.js` 是共享渲染模块，`tools/skill/run.js` 与 `core/user-input/user-references.js` 两处入口一律调用它，不各自拼装模板。目录消息由 `core/system-prompt.js` 在会话起始渲染为消息块。注册表不缓存完整定义；`skills/change` 只作失效通知，运行期发现变更不影响当前会话。

### 5.2 目录注入落点

`core/system-prompt.js` 的装配结果是**消息块**（`{ role, content }[]`）：首条是 system 文本，随后是 skill 目录的 user-role 消息。`render()` 产出 system 文本（`core/system-prompt.js:72-74`），消息块由 `assembleSystemPrompt()` 在 `systemIsNew` 分支产出（`core/loops/nodes/assemble-system/run.js:13-26`、`core/loops/linear.js:139-142`）。两套 loop 引擎（`core/loops/index.js:22` 默认 `node-graph`）走同一入口，目录注入不接进每 step 的 pre-step。

生成时机是**会话起始一次**：`systemIsNew` 为真时与 system prompt 一起装配、一起落库，之后所有轮次从存储读回，不再重新生成，与本项目 system prompt 的既有生命周期一致（`docs/dev/system-prompt.md`）。目录消息排在 `conv[0]` 之后 —— `conv[0].content` 会在 `core/loops/linear.js:273` 与 `core/loops/nodes/model-request/run.js:66` 被 `requestSystem` 覆写。落库时目录消息作为**独立的 user 消息**与 system 消息一并写入 step 0（`core/loops/linear.js:259-264`、`core/loops/nodes/model-request/run.js:53-62`）；`session.prompt`（`core/storage/store.mjs:460-465` 的 `getSessionPrompt`）只回读 system 文本用于 `requestSystem`，目录消息则由 `surfaceNodes` 作为普通历史消息回放，二者协作构成完整消息块。plan-mode 的 POLICY 只拼到 system 消息上（`core/loops/linear.js:204`、`core/loops/nodes/model-request/run.js:103-104`），其余消息原样保留。

消息体用会话目录模板的逐字文案；条目按 `` - `name`: description `` 渲染，description 先折叠空白、按 `catalogDescriptionMaxLength` 截断、再做 `&` / `<` / `>` 转义，名称按 `isSkillName()` 校验。这些渲染规则直接落在 `core/system-prompt.js`，不设独立的 catalog 模块。消息落库后走现有 `surfaceNodes` / `requestMessages` 回放（`core/compaction-runner.js:63-66`），作为普通历史消息参与压缩，不做特殊过滤或重建。

会话内目录不变，因此 digest 去重、替换目录消息、空目录替换、压缩后重建、依据工具可见性动态退化目录都不实现。`user/permissions.json` 里 `skill` 工具的可见性只影响工具本身，不改变已生成的目录。

### 5.3 skill 工具落点

`tools/skill/registry.json` 声明工具身份，字段与本项目现有工具（如 `tools/bash/registry.json`）一致：`name: "skill"`、`type: "read"`、`entry: "run.js"`、`defaultVisible: true`；`description` 用 dsh 的逐字文案（`dsh-tool-skill/lib/index.js:789-791`）；`parameters` 为 JSON Schema 对象 `{ "type": "object", "properties": { "name": { "type": "string", "description": "The exact skill name from the available skills list." } }, "required": ["name"] }`（`core/index.js:459-464` 的 `_toolDefs` 原样透传给模型，等价于 dsh 编译 schemastery 后的 JSON Schema，模型侧契约一致）；省略 `prompt` 字段，调用指引由目录消息自带（见 5.5）。`tools/skill/run.js` 实现 `run(args, exec)`，执行流程与 dsh 一致：校验 `isSkillName` → 在注册表中找摘要 → 校验 `modelInvocable` → 按 `exec.cwd` 重读完整定义 → 二次校验 → 调用 `core/skills/content.js` 的共享渲染产出 `<skill_content>` 块文本。`exec.cwd` 来自本轮 workspace，对应 dsh 的 `ctx.workingDirectory.ensure()`。错误按本项目约定抛异常，由 `core/tools/executor.js` 统一渲染为 `Error: <message>`；工具结果作为 `role: "tool"` + `tool_call_id` 消息回灌（`core/loops/linear.js:431`、`core/loops/nodes/tool-approve/run.js:64`）。工具由 `core/tools/registry.js` 在进程启动时扫描 `tools/*/registry.json` 装载一次（`core/index.js:688`），下发形状由 `core/index.js:459-464` 的 `_toolDefs` 固定；`user/permissions.json` 需要为 skill 配 `allow`，否则按缺省 `ask` 每次弹审批（`core/permissions.js:40`）。

本项目**不实现** dsh 的 `/name` 文本手势。该手势是 dsh 的**用户习惯**（用户在消息里手打 `/name`），不属于本系统与模型的通信契约——契约为 4.1 的目录消息 + 4.5 的 `skill` 工具，二者产出的 `<skill_content>` 同模板、模型侧无差别。其原先在缓存/落库侧的「手势消息」分支（`core/loops/linear.js`、`core/loops/nodes/model-request/run.js` 的 gesture 落库点）已移除，输入准备链路只保留 `@` 引用一条。

用户主动注入技能改由 UI 的 `type:"skill"` 引用块承担（见 5.8）：同样渲染 `<skill_content>`、经 `isUserInvocable` 门控，但触发来源是引用参数而非文本解析，且归入 `resolveReferences` 的引用处理（持久会话注入）。

### 5.4 存储

`core/storage/schema.mjs` 已有 `skills`（`name` / `description` / `prompt` / `path`）与 `tool_skills` 关联表，以及 `core/storage/store.mjs:596-613` 的 CRUD 与 `:709-719` 的 `skill.*` / `toolSkill.*` 操作名（经 `core/index.js:639-641` 的 `storage` 通道转发）。规格以文件系统为唯一真源：这些表只作 UI 展示与索引，不作为运行时的 skill 定义来源；`prompt` 字段对应 `SkillDefinition.content`。`tool_skills` 的 skill ↔ tool 多对多关联在本规格里不参与加载或调用门控，只保留为索引数据。目录消息由 `message.add` 落库为普通消息行，不引入 `source` 列与 `session_events` 特殊通道；后续若确实改 schema，按项目约定直接删 db 文件重建，不写迁移。

### 5.5 系统提示与压缩

skill 目录由 `core/system-prompt.js` 生成，作为消息块里的 user-role 消息与 system 消息并存；这里是装配模块名，目录消息本身的角色仍是 user，与 dsh 一致。`tools/skill/registry.json` 不需要 `prompt` 字段，调用指引由目录消息自带。会话起始装配一次后冻结，运行期增删 skill、工具可见性变化都不改变当前会话的目录，新建会话才刷新。

压缩沿用现有 `surfaceNodes` / `requestMessages` 栈（`core/compaction-runner.js:63-66`）：目录消息是普通历史消息，被压缩隐藏后不重建。这与 dsh 的「下一份完整快照重新建立当前目录」不同，属于本项目的实现范围决定。

### 5.6 配置项

上述配置项全部位于 `user/settings.json` 的 `skills` 对象内（如 `{ "skills": { "catalogDescriptionMaxLength": 500, "customSkillDirs": [] } }`）。未配置时取下表默认值。

| 配置 | 默认值 | 作用 |
|---|---|---|
| `catalogDescriptionMaxLength` | 500（整数最小 3） | 目录里 description 规范化后的最大长度 |
| `customSkillDirs` | `[]` | rank 300 的自定义根目录 |
| `bundledSkillDir` | 项目根 `<root>/skills`（相对进程 cwd 解析，当前为空，已被 `.gitignore` 忽略） | rank 600 的内置系统 skill 根目录 |
| `collectCacheMaxEntries` | 128 | 完成的 cwd/provider 目录缓存上限 |
| `watch` | `true` | 根目录变更监视（仅影响提供方发现缓存失效，不触发当前会话目录刷新） |
| `providerName` | `"filesystem"` | 提供方在注册表中的唯一名 |

校验规则照 `dsh-tool-skill/lib/index.js:1091-1093`：`catalogDescriptionMaxLength` 非整数或小于 3 时抛错。`watch*` 系列只影响提供方自己的发现缓存失效，不触发当前会话目录刷新。

### 5.7 取舍

- **不引入 cordis 分层 scope。** dsh 的注册表按宿主 + scope 分层，同名 skill 由最近层直接胜出；本项目是单进程单 agent 会话，按单层 rank 裁决，`SkillViewOptions.scope` 不进入本项目 API。
- **不实现 Remote seam。** `ctx.sessionSkillCatalog` 的 `@Remote` 协议在桌面端由 UI 侧 `skills.list` IPC 直接调用本地注册表取代，返回同样的 `SkillEntry` 形状。
- **不实现会话内目录变更。** 目录由 `core/system-prompt.js` 在会话起始生成一次并冻结；dsh 的 digest 去重、替换目录、空目录停用旧名称、压缩后重建、依据工具可见性动态退化目录都不实现。运行期增删 skill 或改变 `skill` 工具可见性，对当前会话不可见，新建会话才刷新。
- **共享渲染一律抽取复用。** `core/skills/content.js` 产出与 dsh 逐字相同的 `<skill_content>` 模板，`tools/skill/run.js` 与 `core/user-input/user-references.js` 两处入口共同依赖，不各自拼装；目录条目的规范化、转义与截断同理落在 `core/system-prompt.js` 一处。
- **工具结果不向模型暴露 schema（与 dsh 一致）。** dsh 的 `output.schema` 仅用于框架内部：校验 `execute` 返回结构（`dsh-tools/lib/index.js:3639`）与 PTC 子代理/工作流的类型生成（`dsh-tools/lib/index.js:1831,2541`），并不进入主 chat 路径发给模型的工具定义（该路径只下发 `name`/`description`/`parameters`）；仅 delegation 子代理投影时才随工具定义带出（`dsh-tools/lib/index.js:3125`）。模型收到的始终是 `output.render(execute(...))` 渲染出的 `<skill_content>` 文本（`dsh-tools/lib/index.js:3644`）。本项目 `run()` 直接返回共享渲染模块产出的文本，模型视角与 dsh 完全相同——只见到渲染后的正文，从不见 schema。
- **frontmatter 只认本文档列出的字段集，未识别顶层键按 dsh 默认直接丢弃（不折叠进 `metadata`）。** 仅显式 `metadata:` 对象被原样保留进 `SkillDefinition.metadata`（对应 `dsh-skill-filesystem/lib/index.js:882-885` 的 `optionalMetadata` 只读 `data.metadata`）；其余未列出的顶层键（如 `version`、`requires`）直接丢弃，不参与调用策略、也不进 `metadata`。`core/skills/filesystem.js` 不实现未知键折叠。
- **内置系统 skill 根目录为项目根 `<root>/skills/`。** 对应 dsh `bundled` rank 600 的 `bundledSkillDir`（`BUNDLED_SKILL_RANK = 600`，由 `core/skills/filesystem.js` 以最高 rank 扫描）。该目录当前为空、内容待定；skill 结构（目录包 `<name>/SKILL.md` 与扁平 `<name>.md`、`name`/`description` frontmatter）参照 dsh `SKILL.md` 格式。注册表不自行合成任何内置 skill，只扫描该目录加载。
- **不实现 dsh 的 `/name` 文本手势。** 该手势是 dsh 的用户习惯，非本系统与模型的通信契约（契约为目录消息 + `skill` 工具）；其缓存/落库分支已从 loop 引擎移除，输入准备链路只保留 `@` 引用。用户主动注入技能改由 UI 的 `type:"skill"` 引用块承担（见 5.8）。

### 5.8 UI 暴露面（本项目扩展）

dsh 的 UI 只有只读目录（`ctx.sessionSkillCatalog`）与 `skill` 工具，没有「把技能当引用」的概念；本项目额外在 UI 暴露两处，均为 dsh 没有的扩展：

- **左侧只读技能弹窗**：侧栏「🧩 技能」按钮（`thread-sidebar` 中位于 `models-btn` 与 `permissions-btn` 之间）打开只读 `skills-modal`，布局树见 `docs/ui.md` skills-modal。左栏 `provider-skill-tree-list` 按 `source`（dsh 的 6 个发现根：project-dsh / project-agents / custom / user-dsh / user-agents / bundled；runtime 技能回退到 `provider`）分组列出 `skills.list` 返回的技能（`tree-search-input` 过滤名/描述），点击 `skill-name-label` 在右栏视口查看；右栏 `skill-tab` 经 `skills.get` IPC 拉取完整定义，展示 `skill-meta`（来源 / 名称 / 描述 / modelInvocable 徽标，均为只读）与 `skill-content`（经 `AgentMarkdown` 渲染的完整技能正文）；右栏 `skills-panel` 仅 `close-skills-btn`。技能无费用概念，故 `skill-meta` 不含 `models-modal` 那样的 `fee-selector`（ui.md 的 skills-modal 树照搬了 models-modal 结构，该节点对技能无效，不实现）。弹窗只读浏览，无编辑/保存，与后端 `skills.list` / `skills.get`（只读）一致。分组用 `source` 而非 `provider`：本项目只注册了 1 个 filesystem provider（见 5.7），`provider` 对文件技能恒为 `filesystem`，只有 `source` 能区分 dsh 的 6 个根。
- **composer `@` 菜单的技能引用块**：`@` 菜单新增「🧩 引用技能…」，点击后打开 `skill-ref-selector`（见 `docs/ui.md`）而非编号选择：从 `skills.list`（已按 `isUserInvocable` 过滤，故选择器只出现用户可调用技能）拉取，渲染 `skill-search-input`（按名/描述过滤）＋ `skill-list`（每个 `skill-element*` 显示名称与描述，点击即引用）。选中后向 `App.pendingRefs` 推入 `{ type: "skill", name, label: "@"+name }`，随 chat 的 `references` 参数发出。引用 chip 以 `🧩` 图标与文件/会话引用区分。

**`type:"skill"` 引用解析**：`core/user-input/user-references.js` 的 `resolveReferences` 新增 `type:"skill"` 分支（与 `file`/`session` 同源，走 `references` 参数而非文本手势）。对每个 `name`，经 `core.skills.list({ cwd })` 查找、`isUserInvocable` 门控、`core.skills.get(name, { cwd })` 取正文，用共享 `renderSkillContent` 渲染成 `<skill_content>` 块，收集到 `skillParts` 并拼在「引用上下文」合并消息末尾（指令最靠近回答）。该分支仅在持久会话注入（与 `file`/`session` 引用同一 `persist && core.store` 闸门）；bare 模式不注入。门控与渲染模板与 `/name` 手势一致，但触发来源是引用参数而非手打文本，因此**不引入 dsh 的 gesture 概念**。

面板与 `@` 菜单的 `skills.list` 调用暂不传 `cwd`，作用域默认为进程 cwd；若需严格反映当前会话可见技能，可改用选中会话的 workspace cwd（多一次 store 查询），列为后续增强。
