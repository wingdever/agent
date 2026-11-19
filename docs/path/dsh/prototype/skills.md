# skills（功能）

技能目录：把本会话可用的技能以清单形式告知模型，使模型知道该在什么时候调用 `skill` 工具。它**不走 section**，而是以一条 user 消息注入。

## 1 它在什么时候出现

- 每步 `agent/pre-step` 计算一次目录摘要。
- 首次发布时写入一条 user 消息；目录发生变化时写一条**替换版**，替换之前的列表。
- 目录为空且发现完整时不发送任何消息。
- 被压缩吸收后会在下一次合格请求重发。

## 2 它注入什么

首次发布：

```text
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

目录变化后的替换发布：

```text
<system-reminder>
The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:

<available_skills>
- `<name>`: <description>
</available_skills>

Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

发现不完整时开场句替换为 `Skill discovery is incomplete. This catalog of currently available skills replaces every earlier available-skills list in this session:`，并在目录后插入一条不完整提示。目录为空且无技能可发布时，不发任何消息。

## 3 它如何配合规则

- **不参与 section 排序**：它是 user 消息，由 `agent/pre-step` 的默认分支加入消息批次，不经过 `system-prompt.md` 的合并与插值。
- **去重**：按条目摘要比较（名字 + 描述 + 完整性）；摘要相同则移除待注入项，变化时替换而不是叠加。
- **与 `skill` 工具的配合**：目录只给摘要，正文只在调用 `skill` 工具或用户显式引用时才以 `<skill_content>` 进入上下文。

## 4 组合条件

- `skill` 工具不可见时不发布目录。
- 加载 Office 技能会给 `office_*` 三件套解锁披露，见 `tools/README.md`。
