# `skill`

## name

`skill`

## description

模型收到的工具说明原文：

```text
Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.
```

## system-section

不贡献 `tool:*` 系统提示词段落；技能目录以独立的 user 角色消息发布（`agent/pre-step` 计算摘要，首次或变化时写入），模板：

```text
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking tool actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

目录变化后的替换模板见 communicate-contract.md 4.5。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "The exact skill name from the available skills list."
    }
  },
  "required": [
    "name"
  ]
}
```

## result-format

返回技能正文的固定包装：

```text
<skill_content name="<name>">
<skill_resources>
<base 或 provider 提示>
Load referenced resources only as needed.
</skill_resources>

<skill_instructions>
<skill 正文>
</skill_instructions>
</skill_content>
```

资源提示三选一：`Base directory for this skill: <path>`、`Base URL for this skill: <url>`、`Resources for this skill: <description>`；无资源基址时为 `Resources for this skill are managed by provider "<provider>".`。用户显式调用技能时注入同一包装，模型在两条路径上看到完全相同的形状。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配技能注册表与文件系统提供者时注册。
- 目录只列模型可调用的技能；用户可调用的技能走显式引用注入。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 组合装配了技能注册表 | `skill` 工具可用，每步 pre-step 生成技能目录消息 |
| 技能目录为空且发现完整 | 不发送任何目录消息 |
| 目录变化 | 发送替换版目录消息，替换之前的列表 |
| Office 技能被加载 | Office 三件套在下一步起披露 |

### 展示投影

技能正文以普通文本块呈现；用户显式调用与工具调用共用同一包装。

## 来源

- 包：`@deepseek-ai/dsh-tool-skill`（`reference/deepseek-harness/packages/skill/tool-skill`）
