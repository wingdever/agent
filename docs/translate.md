# auto-translate（中英自动翻译）

让模型始终只看到英文，同时让用户用中文输入和阅读。模型侧历史只存英文；中文只用于显示。system prompt 固定包含 `Always answer in English.`；旧 session 不做兼容，直接删除即可。

## 行为

| 场景 | 处理 |
| --- | --- |
| 用户输入含汉字 | 先翻成英文再发给模型。UI 主块显示英文译文，副块「中文原文」默认展开。 |
| 用户输入纯英文/代码 | 不翻译，原样发送（已经是英文环境）。 |
| 模型最终回答含英文散文（无论夹带多少中文） | **一律翻成中文**。英文里夹带大量中文引用、中文代码注释或专有名词，都不再作为跳过理由。 |
| 纯中文回答 | 已经是中文，跳过。 |
| 纯代码/命令回答 | 跳过翻译：没有散文可翻，避免翻译模型拆掉代码围栏。 |
| `thought` / 工具参数 / 工具结果 / 错误信息 | 不翻译。 |
| 中间带 `tool_calls` 的助手文本 | 不翻译，只有最终回答翻译。 |

翻译 prompt 要求保留 Markdown、代码块、行内代码、URL、文件路径、命令和专有名词；原文已经是目标语言时原样输出。

## 失败策略

- **输入翻译失败**：本轮不发送。UI 恢复输入框、移除未发送的气泡、提示改用英文；不写库、不创建 turn。turn 日志里 `reason=translation-error`。
- **输出翻译失败**：不影响回答。UI 只显示英文原文，并在下方提示「翻译失败，已显示英文原文」。
- 输入超时默认 20s，输出超时默认 30s；**超时不重试**（避免阻断时间翻倍）。连接错误 / 5xx / 429 重试一次，4xx 不重试。
- 英文→中文的译文若不含中文且原文有散文，视为失败；原文是纯代码时允许译文无中文。

## 存储

翻译**不落库**。`messages.content` 始终是模型侧的英文；重载会话后只剩英文，无法再对照中文。因此不需要改 schema，也不需要旧数据迁移。

## 配置

`user/settings.json`：

```json
{
  "translate": {
    "enabled": true,
    "baseUrl": "https://index-translate.bilibili.com/v1",
    "model": "Index-Translate-35B-A3B",
    "apiKey": "",
    "params": {
      "temperature": 0,
      "chat_template_kwargs": { "enable_thinking": false }
    },
    "inputTimeoutMs": 20000,
    "outputTimeoutMs": 30000,
    "timeoutMs": 30000
  }
}
```

- `enabled` 默认 `true`；设置弹窗只暴露开关，其余字段直接改文件。
- `inputTimeoutMs` / `outputTimeoutMs` 分别控制输入（阻断）和输出（不阻断）的等待；缺省时回退到 `timeoutMs`。
- `params` 会原样合并进请求体，用来支持 `chat_template_kwargs` 这类供应商参数。
- 未配置时使用上面的默认值；`apiKey` 为空时不发 `Authorization` 头。

## 事件

`core/index.js` 在翻译前后发 `translation` 事件：

```json
{
  "type": "translation",
  "role": "user | assistant",
  "phase": "start | done | error",
  "sourceLang": "zh | en",
  "targetLang": "en | zh",
  "source": "原文",
  "text": "译文",
  "error": "失败原因（phase=error 时）"
}
```

顺序：用户 `start/done` → 模型请求 → 助手 `start/done` → `done`。输入失败时 `translation/error` 后紧跟 `turn-end {status:"failed", reason:"translation-error"}`。

## UI 节点

- `translation`：`<details open>` 副块，`data-name="translation"`。
- `translation-body`：翻译正文；助手侧用 Markdown，用户侧用纯文本。
- `translation-error`：输出翻译失败的提示行。
- 用户块主文仍是 `user-input`（英文译文）；助手块主文仍是 `answer`（英文原文）。

`docs/ui.md` 未同步这几个节点（按项目约定不擅自改该文件）。

## 已知边界

- 旧会话不兼容：旧 session 的 system prompt 已冻结，不会自动补 `Always answer in English.`；直接删除旧 session 即可（本项目历史数据不重要）。
- 不翻译 `reasoning_content`，不翻译工具卡。
- 切换会话后当前翻译消失（不落库、不缓存）。
- 纯英文输入不会调用翻译服务；模型回答有英文散文时调用一次，纯中文/纯代码跳过。


## TODO
now bilibili translate api not support long text, for thought and answer need other way.