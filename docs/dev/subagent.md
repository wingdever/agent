# subagent
seam: ctx.subagents

1. backgroundMode: one-shot,continue

one-shot ctx.subagents.start(name, request)
continue startContinuable(spec) / followup / interrupt

2. provider: spawn,fork,acp(agent client protocol)

spawn: inherit with new session history in same process
fork: as spwan except inherit session history in same process
acp: only inherit worksapce in new process




## tool-subagent
packages/subagent/tool-subagent/src/{index,model-selection,model-selection-settings,list-models}.ts
agentOptions: { provider, model, reasoningEffort, maxTokens }
    subagent-model-selection
    modelSelectionSettings: true
    list_subagent_models

getProvider:
    spawn/fork same process
    acp/dsh-sdk new subprocess
    claude-code/codex bridge CLI
return:
    run.result
    reportFrom

```ts
// 请求可:选模型、要求结构化输出、限制委托深度、限制子 Agent 工具、设子 persona
const run = await ctx.subagents.start('spawn', {
  prompt: '帮我分析这个仓库的 TODO',
  outputSchema,          // 可选:强约束最终结果结构
  depthLimit,            // 可选:封顶委派深度
  toolFilter,            // 可选:限制子 Agent 可见工具
  signal,                // 必填:发布前的取消通道
})
const result = await run.result   // 一次性子 Agent 的最终结果
```
## tool-subagent-control
send_message / interrupt_agent / list_agents



```ts
const { childId, messageId } = await ctx.subagents.startContinuable({
  label: 'research-assistant',
  initialPrompt: '这是一个常驻研究助手,随时找我',
})
// 后续发消息(精确的直接父 agent 认证后才放行)
await ctx.subagents.followup(parent, childId, '再查一下 MCP 最新进展')
// 打断一个可续子 Agent 的当前轮次(保留其 inbox 与后代)
await ctx.subagents.interrupt(targetSessionId, authority)
// 列直接会话级子 Agent / 拉平整棵会话树
await ctx.subagents.listChildren(parentSessionId)
await ctx.subagents.listDescendants(rootSessionId)
```

## tool-workflow
run a JS chestrate script section fan out subagents.
@deepseek-ai/dsh-tool-workflow ctx.workflowEngine
dsh-workflow-worker-thread

```
meta    必填身份数据: { name, description, phases? }
script  必填纯 JS 函数体(顶层 await;不要 export const meta)
args    可选 JSON,作为 args 全局暴露给脚本
```

usable chestrate hook: agent / pipeline / parallel / phase / log

## tool-ralph
for a same goal, run a new agent to iterate each time.
which schedule as fresh-agent iterative loop