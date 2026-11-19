# 运行时上下文快照

## 1 概念

运行时上下文是「本会话此刻的运行事实」，与「这一轮说了什么」正交。它以快照形式交给模型：一组有序的命名来源，每次渲染成一条完整的 user 消息。

system prompt 只承载部署级静态内容：身份开篇、persona、工具指引。凡是随会话变化或随进程变化的事实都进快照，不进 system prompt。这样同一部署下所有会话的 system prompt 逐字相同，前缀缓存覆盖面最大。

## 2 来源与顺序

来源按固定 order 排列，同一 order 内按名称的码元序排列：

| order | 名称 | 内容 |
|---|---|---|
| 100 | `working-directory` | 当前工作目录 |
| 110 | `sandbox-policy` | 沙箱策略（本部署不实现，占位不注册） |
| 115 | `approval-policy` | 审批策略档位，以及委托子代理的固定拒绝策略 |
| 120 | `subagent-delegation` | 委派范围、agent 身份、协作指引 |
| 200 | `harness-source` | 项目根、运行入口等进程级路径 |
| 210 | `web-surface` | Web 入口地址（有该入口时注册） |

每个来源提供 `{ name, order, text(ctx) }`，返回空串表示本次不参与。

`subagent-delegation` 一项内包含三段，顺序固定：

1. **委派范围**（仅子会话）：
   > You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
2. **身份段**（所有会话）：
   - 根：`You are the root agent. Your name is "<root-name>".`
   - 子：`You are a subagent delegated by agent "<parent-name>".` / `Your name is "<path>".` / `The root agent of your collaboration tree is "<root-name>".`
3. **协作指引**（按当前可见工具生成）：
   - 可见 `send_message`：`To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).`
   - 可见 `list_agents`：`Use list_agents({}) to find your collaborator agents and their names.`

prompt 不携带模型名、时间与平台信息。时间由 `get_current_time` 工具按需读取，其余信息由工具自行获取。

## 3 渲染

快照渲染为一条 user 消息，内容包在 `<system-reminder>` 内：

```
<system-reminder>
The following information describes your current session:

<body>
</system-reminder>
```

`body` 是各来源文本按 order 用空行连接的结果。首份快照用冒号句式；后续快照改用：

```
The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.
```

正文里出现的 `</system-reminder>` 一律转义，避免提前闭合包裹。

## 4 全量重发

任一来源变化时重发**整份快照**，不发差量。判定口径是有序段列表「名称 + 文本」全等：

- 全等：不生成消息，本 step 没有快照。
- 不等：生成一份新快照，包含全部来源的当前文本。

旧快照不删除。它在会话历史里保留，语义上被文首的替换声明废止，物理上由压缩吸收；压缩把保留的最新快照移除后，下一份快照重新以首份句式出现。

只重发快照那一段，其前的历史逐字不变，因此历史前缀仍然可命中缓存。

## 5 求值时机

每个轮次的开头求值一次。快照在轮内不重新求值：轮内工具改变了工作目录或策略，变化在下一轮生效。

这个取舍让轮内请求的尾部保持稳定，且实现上只需在轮次边界看一次事实。

## 6 落库

快照消息落库为 `role=user`、`source=runtime-context` 的普通消息，与其他 user 消息一起参与回放与压缩。

- UI 依据 `source` 把它折叠为会话信息卡，不当作人说的话。
- 压缩可以把它吸收进摘要；吸收后下一轮会生成新快照，因为保留的最新快照已不存在。
- 快照不进 inbox：它不是投递来的输入，而是每轮现算的派生内容。
