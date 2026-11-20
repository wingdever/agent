# 工具能力面

## 1 目的

工具是可替换插槽：新建 `tools/<name>/` 放入 `registry.json` 与 `run.js` 即被加载。工具不能直接依赖 `core/`，它与业务能力之间只经 `exec` 交互。能力面把「`exec` 上有什么」从逐工具手写的字段，变成按声明装配的能力表。

新增一个需要业务能力的工具，只做两件事：在 `registry.json` 声明所需标签，在 `run.js` 里从 `exec.capabilities` 取。装配节点不改。

## 2 标签

标签形如 `<domain>.<verb>`，与 RPC 命令名同一套点分风格：

| 标签 | 语义 |
|---|---|
| `fs.read` | 读取文件内容 |
| `fs.observe` | 读前写观察与版本 CAS |
| `delegation.spawn` | 从主会话派生零上下文子代理 |
| `delegation.fork` | 派生继承历史的子代理 |
| `delegation.send` | 向树内 agent 投递消息 |
| `delegation.interrupt` | 中止后代当前轮次 |
| `delegation.list` | 列出 subagent 树 |
| `delegation.wait` | 等待下一个 step 的输入 |
| `interaction.approval` | 请求工具审批 |
| `interaction.question` | 向用户提问 |
| `interaction.plan` | 提交计划审阅 |
| `interaction.userJob` | 派发并管理用户任务 |
| `background.job` | 列出、读取、终止后台任务 |
| `goal.manage` | 目标状态机读写 |
| `plan.mode` | 计划态读写 |
| `todo.write` | 写入 turn 内 todo 投影 |
| `skill.invoke` | 调用技能 |
| `store.query` | 只读查询会话与历史 |

标签是能力名，不是服务名：工具不据标签推断服务对象的内部形状。

## 3 声明

工具在 `registry.json` 里用 `requires` 列出所需标签：

```json
{
  "name": "send_message",
  "requires": ["delegation.send"],
  "parameters": { "...": "..." },
  "entry": "run.js"
}
```

空数组或省略表示不需要任何业务能力，工具只做纯计算或纯文件操作。声明了未注册的标签，装配时该工具拿不到对应能力，执行返回错误而不是崩溃。

## 4 登记

服务自报能力：每个服务导出 `capabilities()`，返回 `{ <tag>: fn }`。`core/capabilities.js` 把所有服务的自报结果合并成一张只读表，并在启动时校验标签不重复。

- 服务与能力清单在同一处维护，新增能力不改任何全局表。
- 一个标签只由一个服务提供；重复声明在启动时报错。
- 能力表是只读快照，轮次之间不变。

## 5 exec 形状

装配节点按 `requires` 从能力表取出子集，构造：

```
exec = {
  cwd,
  sessionId,
  callId,
  toolName,
  agent,                 // 调用方 agent 实例（光标 agent），供需要身份的工具使用
  capabilities: { <tag>: fn },
}
```

工具只经 `exec.capabilities[tag]` 访问业务能力。

## 6 边界判据

- `tools/` 目录下的代码不得 `require` `core/` 下的任何模块。
- 工具的 `run(args, exec)` 里不出现 core 服务的类型名，只出现能力标签。
- 新增工具不需要修改 `core/loops/nodes/tool-execute/`。
- 需要按会话寻址状态的工具（plan 态、todo 投影）只经 `exec.agent` 读写实例，不在模块或 `exec` 上另立按 sessionId 的状态表。
- 能力标签的新增意味着服务侧新增实现，不是节点侧新增字段。

这三条由架构扫描校验：`tools/` 对 `core/` 的依赖为零，且 `exec` 的字段集合由单一装配点决定。
