# 规划 #1 — 轨迹面板落地

> 对标 DSH Trajectory 面板：把"模型所见所做"可视化为可回溯的时间线。
> 决策来源：`dsh-replica.md` §4(#1 高优先)、§5(复用现有事件流)、PLAN.md §1(#1 一期)。

## 1. 目标

将 `#trajectoryTab`（当前空状态）实现为**会话级时间线**，按 `turn → step → (message / call)` 聚合渲染，使每次会话的"思考 / 工具调用 / 文件改动 / 终端命令"逐条可展开回溯，定位"哪一步模型想错、哪个工具返回异常"一目了然。

**复用现有数据**：core 已将对话落库到 `turns/steps/messages/calls`（`core/storage/schema.mjs`），前端 `app.js` 的 `onChatEvent` 已把同类事件渲染进 chat-tab。轨迹面板**不新增数据采集**，只新增一个只读可视化视图。

## 2. 数据来源（无需改 core 采集）

查询路径（API 见 `core/storage/store.mjs`）：

```
listTurns({ session_id })            → turns (seq, status)
  listSteps({ turn_id })             → steps (seq, status)
    listMessages({ step_id })        → messages (role, thought_id, content_id)
    listCalls({ reply_id })          → calls (name, arguments, description, status, result_id, error, category)
```

- 思考（thought）：`messages.thought_id` → `contents.content`
- 回答（answer）：`messages.content_id` → `contents.content`
- 工具调用：`calls` 整行（已有现成 `makeToolCallCard` 渲染逻辑可复用，`app.js:620`）
- 文件改动 / 终端命令：由 `calls.category` + `name` 区分（如 `write`/`edit` 视为文件改动，`bash` 视为终端命令）

> 注意：`bare-chat` 活动不落库（app.js 注释明确），其轨迹为空——符合预期，UI 显示"该活动不记录轨迹"。

## 3. 渲染架构

```
#trajectoryTab
  └ .traj-turn (data-turn-id, 显示 turn.seq + status 徽标)
      └ .traj-step (data-step-id, 显示 step.seq + status)
          ├ .traj-thought   (折叠, 思考摘要, 点击展开全文)
          ├ .traj-answer    (Markdown 渲染, 复用 markdown.js)
          └ .traj-calls
              └ .tool-call  (直接复用 app.js 的 makeToolCallCard；点击 → 右侧 context-panel 显示参数/结果，与 chat-tab 行为一致)
```

- **聚合为"步骤卡"**（`dsh-replica.md` §5）：每个 step 一张卡，内含思考摘要 + 工具调用列表 + 文件 diff 入口 + 终端命令。
- **可展开回溯**：thought 默认折叠；tool-call 点击联动右侧 `context-panel`（已有 `ctxArgs/ctxResult` 渲染，app.js 中 tool-call 卡片已绑定该行为）。
- **与活动分组**：若某 turn/step 关联某个 activity（见 PLAN.md 前置 A/B），可在 turn 级加活动分隔标签；一期可先不加，预留 `data-activity` 钩子。

## 4. 切换与加载

- 标签切换机制已就绪：`viewport.classList.add("show-trajectory")`（`app.js:114`）+ CSS `styles.css:40-41` 控制显隐。
- **加载时机**：切换到 trajectory-tab 时，按 `currentSessionId` 异步拉取 `listTurns` 树并渲染；切回 chat-tab 不清空（缓存于内存，会话切换时重置）。
- **增量更新**：若用户在轨迹 tab 打开期间对话继续，可监听 core 事件增量追加（二期优化，一期仅打开时全量加载）。

## 5. 落地步骤（实现期任务清单）

1. **DB 层**：`store.mjs` 确认 `listTurns/listSteps/listMessages/listCalls` 已暴露且可用（据 schema 应已具备；实现时实测）。如需按 session 直查 step/call 的便捷方法可补一个 `getTrajectory({ session_id })`。
2. **API 通道**：`ui/web/api.js` 增加 `getTrajectory(sessionId)` 调用 core 对应 RPC（或在已有 session 加载流程里附带）。
3. **渲染模块**：`app.js` 新增 `renderTrajectory(sessionId)`，构建 `.traj-turn/.traj-step/.traj-calls` 树，复用 `makeToolCallCard` 与 `markdown.js`。
4. **空状态**：无 turns → 显示"暂无轨迹"；bare-chat → 显示"该活动不记录轨迹"。
5. **样式**：`styles.css` 补 `.traj-*` 基础样式（沿用现有 `.tool-call`/`.tab-body` 视觉语言，不新建设计体系）。
6. **联动**：tool-call 点击 → 触发现有 `context-panel` 详情逻辑（确认 app.js 中该绑定对轨迹 tab 内的卡片同样生效，必要时在选择器上加 `.trajectory-tab` 作用域）。

## 6. 验收标准

- [ ] 切换"轨迹"标签，展示当前会话的 turn/step 层级时间线。
- [ ] 每个 step 可看到思考摘要、回答、工具调用列表。
- [ ] 点击工具调用卡 → 右侧 context-panel 显示参数与结果（与 chat 行为一致）。
- [ ] 思考内容可展开/折叠。
- [ ] bare-chat 会话显示"不记录轨迹"提示。
- [ ] 切换会话后轨迹随之刷新。
- [ ] 不新增任何 core 事件采集逻辑（纯前端可视化）。

## 7. 风险与备注

- **schema 改动**：本规划不改 schema。若后续需活动分组（前置 A/B）才加 `sessions.activity` 列——届时按 AGENTS.md 规则 `rm data/store.db` 重建，不做迁移。
- **性能**：长会话 turns/steps 可能很多；一期全量渲染可接受（dev 场景），二期若卡顿再加虚拟滚动。
- **与 #2 会话列表增强**独立，可并行；但共用"会话选择"上下文。
