# CrewAI

> 可参考项目资料（`docs/roadmap-references.md` 分册）。采集 2026-11-11。

## 仓库

- https://github.com/crewAIInc/crewAI （Python，MIT）
- 文档：https://docs.crewai.com

## 简介

角色型多 agent 框架：**Crews**（角色化 agent 协作）+ **Flows**（事件驱动的状态编排）。"用角色定义专门 agent"的开源参照中最完整的。

## 关键特性

- **Agent = role + goal + backstory**（Role-Goal-Backstory 框架）：role（专门职能，如 "Senior UX Researcher specializing in user interview analysis"）、goal（结果导向目的 + 质量标准 + 成功判据）、backstory（经验与工作方式）；可选：llm/tools/max_iter/**allow_delegation**（委托需显式允许，默认关）/reasoning（先反思规划再执行）/memory。
- **Task**：description + **expected_output**（完成的样子的详细描述）+ **context**（显式声明依赖哪些其它任务的输出）+ **guardrail**（输出校验函数，失败自动重试，默认 3 次）+ output_file / output_json（Pydantic 结构化输出）。
- **Process**：sequential（按任务序）/ hierarchical（**manager agent** 分派任务 + 验证结果）。
- **Flows**：事件驱动、有状态、精确控制；Flow 与 Crew 的关系：Flow 管状态与触发事件，Crew 干复杂协作活，结果回 Flow 继续。
- **配置即定义**：`crew.jsonc` + `agents/*.jsonc`（声明式，不只有代码）。
- **Memory**：短期/长期/实体三类；crew 级 knowledge sources；crew 级 skills 目录。
- **Planning**：AgentPlanner 在每次 crew 迭代前生成计划，注入各任务描述。
- **Checkpointing**：自动 checkpoint（可配置）。

## 对本项目的借鉴/融合点

| 我们的条目 | 借鉴点 |
|---|---|
| M4 专门 agent | role/goal/backstory 三元模板 = 我们"代码/调研专门 agent"的最直接形态定义（我们的 activity + system prompt + 工具集 ≈ role/goal/backstory）；配置即定义（jsonc）可作我们 agent 定义文件格式 |
| M4 交接协议 | `Task.context`（显式依赖声明）+ `guardrail`（交接校验门：校验通过才进下一步）—— 交接协议 = **依赖声明 + 校验**，而非自由消息传递；hierarchical 的 manager 验证是校验角色形态 |
| M4 编排 | Flow（编排层）/ Crew（协作层）两层分离 —— 与我们"会话/turn 层 + agent 层"同构，可作 M4 架构分层参照 |
| M1 ⑤ goal-auto-continue | planning（每次迭代前注入计划）+ max_iter（迭代上限）—— goal 续轮的两个工程参数 |
| M3 ⑪ subagents | `allow_delegation` 模式：委托需显式允许（默认关）—— 我们 subagent 委托的权限语义 |

## 链接

- https://github.com/crewAIInc/crewAI
- https://docs.crewai.com/edge/en/concepts/agents
- https://docs.crewai.com/edge/en/concepts/crews
- https://docs.crewai.com/edge/en/learn/hierarchical-process
