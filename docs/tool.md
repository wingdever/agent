## 工具实现方案

### 目录约定
- 工具代码：项目根 `tools/`
- 工具文档：本文件 `docs/tool.md`

### 工具注册机制
目录化注册（扫描 tools/*/registry.json）

### 等待实现列表
tools:
bash,
textfile_read,textfile_write,textfile_etext_grep,file_touch,file_remove,file_stat,dir_mkdir,dir_rmdir,dir_list,python_run,sql_insert,sql_delete,sql_select,sql_update,web_search,web_fetch

### 具体约定
参照deepseek-harness具体的工具与模型通信的约定

### 权限请求
approval-request { id, name, arguments }

### 模型通信
#### 发送工具清单
payload["tools"] = [
  {
      "type": "function",
      "function": {
          "name": tool.name,
          "description": tool.description,
          "parameters": tool.parameters,
      },
  }
  for tool in tools
]

#### 处理工具调用
for raw_call in raw_message.get("tool_calls") or []:
    tool_calls.append(
        ToolCall(
            id=raw_call["id"],
            name=raw_call["function"]["name"],
            arguments=raw_call["function"]["arguments"],
        )
    )
return Message(
    role="assistant",
    content=raw_message.get("content"),
    reasoning_content=raw_message.get("reasoning_content"),
    tool_calls=tuple(tool_calls),
)



