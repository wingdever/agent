# `ask_user_question`

## name

`ask_user_question`

## description

模型收到的工具说明原文：

```text
Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. An answer item with empty selected and no custom means the user skipped that question: continue without it, do not ask it again, and do not treat the skip as permission.
```

## system-section

不贡献系统提示词段落；使用规则完全写进工具描述。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "description": "Questions to ask the user before continuing.",
      "items": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "id": {
            "type": "string",
            "description": "Stable id for this question; echoed in the answer."
          },
          "question": {
            "type": "string",
            "description": "The specific question to ask the user."
          },
          "header": {
            "type": "string",
            "description": "Optional short heading for the question, such as \"Confirm\" or \"Choose Mode\"."
          },
          "options": {
            "type": "array",
            "description": "Optional choices to show the user. If you recommend one, put it first and append \"(Recommended)\" to that label.",
            "items": {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "label": {
                  "type": "string",
                  "description": "Short user-facing option label."
                },
                "description": {
                  "type": "string",
                  "description": "One sentence explaining the tradeoff or impact."
                }
              },
              "required": [
                "label"
              ]
            }
          },
          "multi_select": {
            "type": "boolean",
            "description": "Whether the user may select more than one option. Defaults to false."
          }
        },
        "required": [
          "id",
          "question"
        ]
      }
    }
  },
  "required": [
    "questions"
  ]
}
```

## result-format

返回 `{ answers[] }`：每个答案对应一个提问 id，含用户选择的 `selected` 标签与可选 `custom` 文本；用户跳过某题时该答案的 `selected` 为空且无 `custom`——模型须继续，不重复提问，也不把跳过视为许可。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配问题 seam（`ctx.userQuestions`）时注册。
- 默认阻塞；`mode: timed` 时前台超时返回 pending 结果，问题仍可回答。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| autonomy 为 autonomous | 所有 `ask` 调用自动 deny，问题不会到达用户 |
| plan-mode 激活 | 该时段问题用于计划阶段的事实澄清与用户选择，不能替代计划提交 |
| 执行器换成 PTC | `run_code` 之外的工具只能从程序内调用；问题仍可经 SDK 调用 |

### 展示投影

等待回答时展示问题卡片；回答后展示所选标签与自定义文本。

## 来源

- 包：`@deepseek-ai/dsh-tool-ask-user`（`reference/deepseek-harness/packages/interaction/tool-ask-user`）
