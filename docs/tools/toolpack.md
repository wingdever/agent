# 工具包

## 范围

工具包（toolpack）是**一个能力所包含的多个工具**的聚合单位。一个工具包拥有：成员工具、共享的提示段、以及这段提示里用到的变量值。

它解决的是"归属"问题：`create_goal` / `get_goal` / `update_goal` 组成 goal 能力，它们的提示段里有一个"至少 N 轮"的阈值；这个阈值属于 goal 能力，不属于任何一个工具，也不属于 goal 模块的配置。工具包就是承载它的对象。

工具包不改变工具的加载、选择与执行方式：工具仍然按 `tools/<name>/registry.json` 独立注册，工具包是在加载完成后合成的。

## 1 定义

### 1.1 工具声明自己属于哪个包

`tools/<name>/registry.json`：

| 字段 | 必填 | 含义 |
|---|---|---|
| `package` | 否 | 包名；缺省取该工具的 `group` |
| `promptSection` | 否 | 提示段名；缺省取包名。一个包可以有多个段（如 `job` 的四个工具各成一段） |
| `promptVarDefaults` | 否 | 该包提示变量的默认值；**只允许写在组长上** |

组长 = 包内**按工具名排序的第一个**成员。这与共享提示段的取文本规则一致（段文本取组内第一个工具的 `prompt`），所以"组长"不是额外概念，而是同一个排序规则。

### 1.2 一个例子

```json
// tools/create_goal/registry.json（goal 包的组长）
{
  "name": "create_goal",
  "group": "goal",
  "package": "goal",
  "promptSection": "goal",
  "promptVarDefaults": { "blockedAfterConsecutiveRounds": 3 },
  "prompt": "... persists for at least {{blockedAfterConsecutiveRounds}} consecutive goal rounds ..."
}
```

`get_goal` / `update_goal` 只需 `"group": "goal"`（或显式 `"package": "goal"`）。`todo_write` 的 `group` 也是 `goal`，但它不属于 goal 能力，因此显式写 `"package": "todo"`。

## 2 用户配置

`user/toolpacks.json`，按包名索引，扁平结构：

```json
{
  "goal": {
    "promptVars": { "blockedAfterConsecutiveRounds": 5 }
  }
}
```

- `promptVars` 覆盖注册表里的 `promptVarDefaults` 同名项，未覆盖的保留默认值；
- 文件缺失或某包未配置都不报错，全部按注册表默认值运行；
- 未知包名、非组长声明的 `promptVarDefaults`、同一段跨多个包，都记一条 `[tools]` 或 `[prompt]` 警告并继续装配，不中断；
- 文件在**进程启动时读取**，修改后需重启生效。

## 3 合成结果

加载完成后，每个工具对象带一个 `package` 引用，包对象形如：

```json
{
  "name": "goal",
  "leader": "create_goal",
  "members": ["create_goal", "get_goal", "update_goal"],
  "promptSection": "goal",
  "defaultVisible": true,
  "promptVars": { "blockedAfterConsecutiveRounds": 3 }
}
```

`defaultVisible` 为成员的与运算结果，目前只作为字段保留，尚未驱动工具选择。

## 4 两个使用方

| 使用方 | 怎么用 |
|---|---|
| 系统提示装配 | 生成 `tool:<section>` 时，取该段工具所属包的 `promptVars`，替换段文本里的 `{{变量名}}`；没有值的占位符保留原样 |
| 工具执行 | `exec.tool` 就是当前工具对象，工具通过 `exec.tool.package.promptVars` 读自己包的配置 |

第二条是关键边界：工具只经由 `exec` 拿到自己的工具对象，不 import `core` 的其它模块，也不读别人的配置文件。goal 工具的"至少 N 轮"下限校验与提示词里的 N 因此天然同源。

## 5 替换规则

提示段文本会做两次替换：

- `{{tools}}` → 本段可见工具名，用 `or` 连接（与 DSH 一致）；
- `{{name}}` → 本段所属包 `promptVars` 里的同名值。

一个段跨多个包时取段内第一个工具（按名称排序）所属包的值，并记警告。只作用于工具提示段；MCP 服务器说明段等外部文本不插值。

## 6 与 group、promptSection 的关系

- `group` 仍是 UI 分类字段，保留原样；
- `promptSection` 仍是"哪几个工具共用一个提示段"，缺省取包名；
- 包是二者的共同上位：缺省由 `group` 推出，成员可用 `package` 覆盖。这样现有工具零改动即可获得包对象，需要拆分时只改一个字段。
