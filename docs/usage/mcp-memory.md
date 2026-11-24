# 接入 MCP 服务：以 Reference Memory 为例

本项目内置通用的 MCP 客户端机制，但不附带任何具体的 MCP 服务。接哪个服务、接几个，全部由你自己写在 `user/mcp.json` 里；不写这一项，软件里就看不到任何 MCP 工具。

本文用 Reference Memory（一个本地知识图谱记忆服务）走完整流程，随后说明换成其他服务时要改哪些字段。

## 1 安装服务

本项目只负责启动服务，不会替你安装，也不会初始化它的数据。

```sh
npm install --global @modelcontextprotocol/server-memory@2026.7.4
```

安装后确认可执行文件在 `PATH` 上：

```sh
which mcp-server-memory
```

## 2 写配置

创建或编辑 `user/mcp.json`，写入：

```json
{
  "servers": {
    "reference_memory": {
      "command": "mcp-server-memory",
      "args": [],
      "env": {
        "MEMORY_FILE_PATH": "${PROJECT_ROOT}/data/mcp-reference-memory.jsonl"
      }
    }
  }
}
```

`servers` 的键 `reference_memory` 就是服务名，模型看到的工具名会带上它（`mcp__reference_memory__*`）。键只能由字母、数字、下划线和连字符组成，长度 1–32。

`MEMORY_FILE_PATH` 决定记忆存在哪里。上面的写法把记忆放在本项目的 `data/` 下，因此记忆跟着项目走，不同项目各自独立。想全机共享一份记忆，改成你自己的一个绝对路径即可。

## 3 启动并确认工具出现

启动应用：

```sh
pnpm start
```

控制台应当出现类似两行：

```text
[mcp:reference_memory] Knowledge Graph MCP Server running on stdio
[mcp] server "reference_memory": 9 tools registered, resources available
```

9 个工具分别是实体与关系的创建、删除、查询相关，模型在需要时会自行调用。同时因为该服务提供资源能力，三个资源工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）也可用。

## 4 验证记忆真的可用

用一个唯一的值走三步，确认写入、跨会话召回和实际使用都成立。整个过程中不要改 `MEMORY_FILE_PATH`。

1. 在会话 A 里说：`Remember that my validation drink is lapsang-<你的唯一后缀>.`
   确认模型调用了写入工具并且返回成功。
2. 新建会话 B（不要复制会话 A 的对话），说：`What is my validation drink? Check memory.`
   确认模型调用了搜索工具并返回刚才那个值。
3. 仍在会话 B 里说：`Use that preference to suggest one drink for the meeting.`
   确认回答用上了召回的值。

只要新建会话即可，不需要重启应用：记忆存在磁盘文件里，新会话读到的是同一个文件。

## 5 换成其他 MCP 服务

`reference_memory` 换成任何 stdio 服务都能用，只需改 `command`、`args` 和 `env`。例如：

```json
{
  "servers": {
    "another_server": {
      "command": "some-mcp-server",
      "args": ["--flag"],
      "env": { "API_TOKEN": "${MY_TOKEN}" },
      "cwd": "/path/to/workdir",
      "timeoutMs": 120000
    }
  }
}
```

远程服务走 streamable-http，给出 `url` 就会自动按该传输连接：

```json
{
  "servers": {
    "remote_docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_DOCS_TOKEN}" }
    }
  }
}
```

字段说明：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `command` | stdio 必填 | 要启动的可执行文件。 |
| `args` | `[]` | 传给它的参数。 |
| `env` | `{}` | 追加给它子进程的环境变量。 |
| `cwd` | 项目根目录 | 子进程的工作目录。 |
| `transport` | 按字段推断 | `stdio` 或 `streamable-http`；省略时有 `url` 就用 http，否则用 stdio。 |
| `url` / `headers` | — | http 服务的地址与附加请求头。 |
| `enabled` | `true` | 设为 `false` 可暂时关掉这一项而不删它。 |
| `timeoutMs` | `60000` | 单次请求的超时预算；服务持续汇报进度时会被顺延。 |
| `maxTotalBudgets` | `10` | 汇报进度的请求最多可超出 `timeoutMs` 的倍数，即总时长上限。 |
| `reconnect` | `3` | 服务意外退出后的重连次数；`0` 表示不重连。 |

所有字段值里的 `${VAR}` 都会在启动前展开：先取环境变量，`${PROJECT_ROOT}` 固定是本项目根目录，取不到的变量原样保留。

出于安全考虑，启动 stdio 服务前会从继承的环境里剔除名字含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的变量以及 `AGENT_` 开头的变量。因此服务需要的密钥请写在它自己的 `env` 里，而不是依赖 shell 环境。

## 6 出问题时

启动时控制台会直接说明原因，常见几类：

| 现象 | 原因与处理 |
| --- | --- |
| `spawn xxx ENOENT` 并最终 `skipped` | 可执行文件找不到。确认已安装且 `which` 能找到；找不到就改用绝对路径写在 `command` 里。 |
| `invalid server name` | 服务名不合规，只用字母、数字、下划线、连字符，长度 1–32。 |
| `has no command` | stdio 条目缺 `command`。 |
| `unknown transport` | `transport` 只能写 `stdio` 或 `streamable-http`。 |
| 工具没出现但也没有报错 | 检查 `user/mcp.json` 是否是合法 JSON，以及 `enabled` 是否被设为 `false`。 |

单个服务失败不会影响启动，其他服务照常工作。

服务运行中意外退出时，它提供的工具会立即从模型侧消失，随后自动重连并恢复；重连次数由 `reconnect` 控制。
