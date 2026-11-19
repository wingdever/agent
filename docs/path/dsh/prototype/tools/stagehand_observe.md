# `stagehand_observe`

## name

`stagehand_observe`

## description

模型收到的工具说明原文：

```text
Find browser actions matching an instruction using the configured Stagehand model.
```

## system-section

本段落与同组工具共用，由同一个注册点提供：

- 段落名：`browser-use:stagehand-native`
- 序号（section order）：`TOOL_COMPUTER_USE`（3000）
- 注册位置：`packages/experimental/browser-use-stagehand-native/src/index.ts:191`
- 非空条件、原文与变体：同组工具共用同一段文本，逐字模板见 [`stagehand_act`](stagehand_act.md) 的 system-section；文本本身不再在本页重复。


## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "instruction"
  ],
  "additionalProperties": false
}
```

## result-format

返回页面观察、提取数据、截图或标签页列表。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 同 `stagehand_act`。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 六件套同时挂载 | 共用段落 |
| `computer-use` 同时存在 | 同序号并存，按名字排序 |

## 来源

- 包：`@deepseek-ai/dsh-experimental-browser-use-stagehand-native`（`reference/deepseek-harness/packages/experimental/browser-use-stagehand-native`）
