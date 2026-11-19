# plan-mode（功能）

计划态策略段：会话进入计划态后，把"只调研、不改文件"的约束注入系统提示词。它只负责**贡献一个受会话态驱动的 section**，规则部分见 `system-prompt.md`。

## 1 它在什么时候出现

- 会话的 `plan/mode` 状态为 active 时，`plan:policy` 非空；退出后为空串。
- 状态在 `agent/pre-step` 阶段按通过准入的 step 落库；同一步的重试复用同一份组装，不会中途改变计划态。
- 退出在**批准的 step 边界**生效：`exit_plan_mode` 批准后，从下一步起不再追加策略。

## 2 它注入什么

`plan:policy`（`PLAN_POLICY`，500），一段 markdown 文本：

```text
You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
```

`exit_plan_mode` 的披露规则也写在段落里：工具目录跨模式保持一致，以便请求缓存稳定。

## 3 它如何配合规则

- **排序**：`PLAN_POLICY`（500），位于 persona 之后、Team 策略与全部工具指引之前。
- **动态性**：段落提供者是函数，读会话投影；plan 态变化时下一次组装输出不同文本，system 节点随之更新（更新方式见 `communicate-contract.md` 的准入规则）。
- **工具目录**：切换计划态**不**增删工具声明，只有段落变化。

## 4 组合条件

- 与 `team:policy`（600）同时存在时按序号先后出现。
- native 执行器下正常渲染；PTC 执行器下段落仍在，但工具调用形态改变，见 `tools/README.md` 的执行器模式。
