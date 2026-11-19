# agent-instructions（功能）

工作区指令：把用户全局、共享与项目级的 `AGENTS.md` 注入模型历史。它**不走 section**，而是以 user 消息注入。

## 1 它在什么时候出现

- 首次请求写入基线；恢复会话时若已有可见基线兼容，则不再重发。
- 首次成功文件操作进入更深目录后，下一次请求追加该目录新发现的指令。
- 字节预算用尽时，用完整替换版基线替换旧的基线。

## 2 它注入什么

基线（宽到窄顺序：用户全局 `AGENTS.md`、共享 `AGENTS.md`、项目 `AGENTS.md`）：

```text
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: <display path>

<file content>

Instructions from: <display path>

<file content>
</system-reminder>
```

字节预算用尽时的完整替换基线开场句为 `This complete workspace instruction baseline replaces all earlier workspace instruction baselines.`，无任何指令时追加 `No workspace instructions are currently active.`，截断时追加 `Workspace instructions were omitted or truncated to fit the configured byte budget.`。

深层目录新发现的指令：

```text
<system-reminder>
Additional instructions from: <display path>

These instructions apply to work under `<scope>`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.

<file content>
</system-reminder>
```

用户全局目录的新发现把第二句换成 `These user-global instructions apply to all work.`。

## 3 它如何配合规则

- **不参与 section 排序**：它是 user 消息，不经过 `system-prompt.md` 的合并与插值。
- **优先顺序**：宽到窄排列，更具体的文件在后；正文明确"更具体的指令优先于更宽的"。
- **去重**：按可见状态 + 版本摘要比对，未变化不重发。
- **与压缩的配合**：基线被压缩吸收后，恢复时重新判定是否需要补发。

## 4 组合条件

- 与 `skills` 同时存在：两者都是 pre-step 注入的 user 消息，按各自触发条件独立写入。
- 某些组合（如 sdk-minimal）不挂载本功能，此时模型看不到任何工作区指令。
