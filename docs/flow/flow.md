# flow 节点图编排

## 范围

flow 是用户手工编辑、可保存复用的节点图。用户画图、配参数，本项目后端按图执行，每个节点的输入输出都落库。本文记录图的数据模型、节点契约、执行语义、存储与接口；界面是这套数据的一个渲染。

## 1 定位

- **图是数据**：一份 `{ nodes, edges, workdir? }` 的 JSON 文档。执行器读它决定执行顺序，不把图编译成代码。
- **与 agent 层无关**：一次执行不创建 Agent 实例、不归属会话、不进轮次。节点拿到的能力只有两项：一次模型调用、一次工具执行。
- **与 `workflow` 工具无关**：workflow 是模型现场写的脚本；flow 是用户提前画的图。两者不互相调用，也不共享状态。
- **可保存、可重放**：图定义与每次执行（节点级输入输出）都落库，历史可查。

## 2 数据模型

### 2.1 图定义

```json
{
  "nodes": [
    { "id": "start_1", "type": "start", "position": {"x": 60, "y": 120}, "data": {} },
    { "id": "llm_1", "type": "llm", "position": {"x": 260, "y": 120}, "data": { "prompt": "总结：{{text}}" } },
    { "id": "end_1", "type": "end", "position": {"x": 520, "y": 120}, "data": {} }
  ],
  "edges": [
    { "id": "e1", "source": "start_1", "sourcePort": "out", "target": "llm_1", "targetPort": "in" },
    { "id": "e2", "source": "llm_1", "sourcePort": "out", "target": "end_1", "targetPort": "in" }
  ],
  "workdir": "."
}
```

- `nodes[].id` 是稳定的字符串 id，边的两端按它引用。
- `nodes[].position` 只给画布用，执行器忽略。
- `edges[].sourcePort` / `targetPort` 是端口名，必须在该节点类型的输出 / 输入列表里。
- `workdir` 可选，是工具节点执行时的相对工作目录，缺省为项目根。

### 2.2 节点类型

每种类型声明输入端口、输出端口和可配置字段。**同一份声明同时驱动画布与执行器**：画布据此画端口与表单，执行器据此校验边、决定分支。

| 类型 | 输入 | 输出 | 字段 |
|---|---|---|---|
| `start` | 无 | `out` | 无。它的输入就是本次运行的输入。 |
| `llm` | `in` | `out` | `system?`、`prompt`、`schema?`、`model?`、`maxTokens?` |
| `tool` | `in` | `out` | `tools[]`、`name`、`args` |
| `condition` | `in` | `true` / `false` | `field`、`op`、`value` |
| `end` | `in` | 无 | 无。到达它的值就是本次运行的输出。 |

`tool` 的 `tools` 为空或省略时表示可用全部默认可见工具；写了则只有列表内的工具可被该节点调用。第一版没有循环节点。

### 2.3 模板

节点参数是字符串模板，`{{path}}` 从**上一个节点的输出**取值：

| 写法 | 含义 |
|---|---|
| `{{text}}` | 上一步输出的 `text` 字段 |
| `{{items.0.name}}` | 数组下标与嵌套字段 |
| `{{}}` | 整个上一步输出 |

第一版**没有表达式语言**：只有路径取值，不做运算。判断由 `condition` 节点承担。路径取不到值是**错误**而非空串——参数写错必须在运行时暴露，而不是安静地把空内容喂给模型。

`tool` 节点的 `args` 逐个字符串叶子做模板替换，其余标量原样传入。

## 3 执行语义

### 3.1 栈与推入

执行器维护一个待执行栈：

1. 栈里放入 `start` 节点；
2. 取出一个节点执行；
3. 按节点返回的端口，把它在该端口上的**所有下游节点**推入栈；
4. 节点返回 `port: null` 时该分支到此为止，不推任何下游。

条件节点的两个端口只有被选中的那个会推下游，未选中的分支因此自然终止——这就是分支的实现方式，不需要额外的「跳过」语义。

### 3.2 节点结果

节点执行返回 `{ port, output }` 或 `{ port: null }`。抛错即该节点失败，整次运行随之失败，错误信息带节点 id。失败的节点、已完成的节点都记一行运行记录。

### 3.3 环与死循环

图允许成环（这是循环图的表达方式），执行器用两道限制保证有限：

- 单个节点在一次运行中最多执行 10000 次；
- 同一节点**连续两次**收到完全相同的输入即判定卡死，立即失败。

运行结束但没有任何分支到达 `end` 节点时，判为失败并明确说明——图跑通了但没有产出。

### 3.4 LLM 节点

一次无状态模型调用，不带历史、不提供工具。`prompt` 与 `system` 先做模板替换。

声明 `schema` 时，schema 作为输出要求写进系统消息，模型回答按 JSON 解析并做最小校验（必填字段存在、声明字段类型匹配、`additionalProperties: false` 时拒绝多余字段）。解析或校验失败**重试一次**（把失败原因告诉模型），仍失败则节点失败。

模型路由：`model` 字段缺省时用当前配置的默认模型，`provider` 同理；`maxTokens` 缺省 4096。

### 3.5 工具节点

按 `name` 从工具注册表取工具，用替换后的 `args` 调用，返回 `{ text, isError }` 作为输出。

工具节点的参数可声明 `tools` 白名单；白名单内的名字不存在的工具在运行时失败。

图执行不经过权限门：图是用户自己编辑的，执行等价于用户直接执行。工具调用传入的 `exec` 只带 `cwd`、`callId`、`store` 与 `isPlanMode`；会话、审批、用户提问、子代理等能力一律不提供，工具若依赖它们会自行返回不可用。

## 4 执行状态

### 4.1 表

| 表 | 内容 |
|---|---|
| `flows` | 图定义：`name`、`description`、`definition`（JSON 文本） |
| `flow_runs` | 一次执行：`status`（`running` / `succeeded` / `failed` / `cancelled`）、`input`、`output`、`error` |
| `flow_node_runs` | 一次执行里的每次节点执行：`node_id`、`node_type`、`seq`、`status`（`succeeded` / `failed` / `skipped`）、`input`、`output`、`error` |

运行行在开始前创建，节点行在每次运行结束后批量写入，都把值序列化成 JSON 文本。保存图定义时先校验再落库。

### 4.2 校验

保存与运行前都校验，一次返回全部违规：

- 节点 id 非空且不重复，类型存在；
- 边的两端节点存在，端口名属于对应节点类型的输入 / 输出列表；不能连进 `start` 或连出 `end`；
- 恰好一个 `start` 节点，至少一个 `end` 节点；
- 所有节点都能从 `start` 到达。

## 5 接口

RPC 命令（`core/rpc/handlers/flow.js`）：

| 命令 | 参数 | 返回 |
|---|---|---|
| `flow.nodeTypes` | 无 | 全部节点类型的声明（无 run 函数） |
| `flow.list` | 无 | 图列表 |
| `flow.get` | `id` | 单张图（`definition` 已解析） |
| `flow.save` | `id?`、`name`、`description`、`definition` | `{ ok, violations? , flow? }` |
| `flow.validate` | `definition` | `{ ok, violations }` |
| `flow.delete` | `id` | 删除结果 |
| `flow.runs` | `flowId` | 该图的执行列表 |
| `flow.run` | `flowId`、`input` | 流式：节点事件 + `flow-run-end` + 最终结果 |

`flow.run` 是唯一的流式命令，事件依次为：

```text
flow-node-start  { nodeId, nodeType, seq, input }
flow-node-end    { nodeId, seq, status, output | error }
flow-run-end     { status, output | error }
```

画布用这些事件给节点上色，不轮询数据库。

## 6 界面

`ui/web/flow-canvas.js` 是原生 JavaScript 画布，不依赖 React，不使用构建步骤。它不是独立页面，也没有单独 HTML：入口是侧栏按钮，画布是运行时创建、挂在 `document.body` 上的覆盖层，与项目其它面板同一种形态。

- **占位**：打开时铺满**左侧会话栏之外的整个窗口**，覆盖中间视口与右侧上下文面板；会话栏自动折叠，关闭时恢复它原来的折叠状态（用户自己折叠过的不会被误展开）。
- **属性面板**：按节点类型的 `fields` 生成表单；`enum` 生成下拉，`object` / `array` 生成 JSON 文本域，其余按类型生成输入框。
- **列表栏**：画布内部最左侧的流程图列表，新建与切换。
- **运行**：输入 JSON 后运行，节点按事件依次标成运行中 / 成功 / 失败 / 跳过，底部显示结果或错误。

## 7 测试

`test/flow.test.js` 覆盖：模板取值与缺失路径报错、校验的全部违规路径与端口方向、执行器的推入与分支终止、失败传播、环检测、LLM 节点的模板与 schema 重试、工具节点的白名单与参数替换，以及服务层的保存校验与运行记录落库。
