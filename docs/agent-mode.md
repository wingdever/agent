# Agent Mode Design

## 核心模型：三轴正交

```
Mode = {
  presence:   in | out
  autonomy:   supervised | autonomous
  activity:   goal-plan | build-code | discuss-doc | research | review-proj | human-learn | diagnose  (7 values)
}
```
- 三轴**正交**，不是平铺枚举。presence 是元状态，跨所有 activity 共享同一套机制。activity 轴现有 **7 个取值**（不含 bare-chat）。
- `risk` 轴**暂不使用**（避免过度设计，日后若 autonomous 出乱子再考虑加回）。
- `bare-chat` 不再是 activity，而是独立的**会话模式层（session mode：bare / persisted）**。`core.chat()` 先按**显式信号** `ctx.mode === "bare"` 分发：显式声明 bare 走 `core/bare-chat.js`（不是 loop engine），否则走 persisted 再由 `AGENT_LOOP_ENGINE` 选择 linear / node-graph。**不用 `!sessionId` 推断**（存在无 sessionId 但需工具循环的合法调用方，persist 只控制落库）；UI 的 `runBareChat` 显式传 `mode:"bare"`。bare-chat 不进入 `core/loops/` 注册表，也不是 `AGENT_LOOP_ENGINE` 的取值。

## 各轴语义

### presence（人类参与状态，自动态）
- 表示"代理推断的参与状态"，非硬事实；model 可自行微调。
- `in → out`：用户无操作 **且** 未主动挂起，持续 **≥10 分钟** → 自动 `out`。
- `out → in`：用户在代理运行中**插话** → 自动 `in`。
- 用户可手动覆盖（主动挂起抑制自动 out；手动切换也允许）。
- agent 层**不做** presence 对应的硬性行为规则，行为由 model 自行判断。

### autonomy（授权自主度）
- `supervised → autonomous`：**自动触发**于 presence 转 `out`（失联=被迫自治）。
- `autonomous → supervised`：**仅用户显式操作**（模式按钮/指令）才降级；presence 回 `in` **不**自动降 → **永久提权**。
- `autonomy = autonomous` 时，所有 `ask` 调用**自动 deny**（代理不再向人提问，自行决策或跳过）。

### activity（代理活动性质，model 自判，无硬守门）
- 七类：`goal-plan / build-code / discuss-doc / research / review-proj / human-learn / diagnose`。
- 默认 activity 为 `research`（UI 建会话初始值与 DB schema DEFAULT 均已改为 research）。
- 代理**可跨 activity**，含跨到 `build-code`（落盘变更）；信任 model 自行判断。
- 只读倾向类：research / goal-plan / discuss-doc / review-proj / human-learn / diagnose；落盘类：build-code。边界由 model 把握。
- **流转模型（UI 层）**：`activity` 是**建会话时选定的初始活动**，运行后可切换，非锁定。
  - 一个活动**完成后**可自然进入其它活动（如 `goal-plan` 经 `exit_plan_mode` 批准后自然进入 `build-code`）。
  - 活动**未完成**时也可**强制切换**，但需**二次确认**防误操作：supervised 下弹内联确认窗（提示将中断进行中的工作、plan-mode 策略即时失效），autonomous 下直接切换（人不干预，与 ask 自动 deny 一致）。
  - 完成态由 model 上报（如 plan 批准），UI 在活动指示器上以 `✓` 标注。详见 `docs/dsh/dsh-replica.md`。

### 会话模式层（session mode：bare / persisted）
`bare-chat` 已从 activity 轴移出，归为与三轴正交的会话模式层，由 `core.chat()` 在**选择 loop engine 之前**按**显式 `ctx.mode` 信号**分发（不从 `sessionId` 推断）：

| 模式 | 判定 | 行为 |
|---|---|---|
| `bare` | `ctx.mode === "bare"` | UI 的 `runBareChat` 显式传此值。无会话 / 不落库 / 无工具（`tools=[]` 硬约束）/ 纯内存历史（`bareHistory`）/ 每轮装配 system prompt；走 `core/bare-chat.js` 的 `runBareChat`，**不是** loop engine。 |
| `persisted` | 其它情况（含「无 sessionId 但未声明 bare」） | 选定 workspace/会话、落库（sessions/turns/steps/messages）、支持 tool_call；由 `AGENT_LOOP_ENGINE` 选择 `linear` / `node-graph` 引擎执行。 |

> 判定用显式 `mode` 而非 `!sessionId` 的原因：历史上 `persist = sessionId && store` 只控制是否落库，**工具执行与 sessionId 无关**；存在 `chat()` 无 sessionId 但仍需完整工具循环的调用方（如 `ask_user_question` / `request_user_job` 测试）。若用 `!sessionId` 推断会静默把它们降级为无工具 bare。

- bare 仍做输入/输出翻译并复用 linear 的终止/`[turn]` 日志/`turn-end` 契约，但 `steps=1`、`tools=0`、不持久化。
- UI 用 `isBare()`（由 `currentSessionId` 派生）决定交互路径，并在 bare 的 `chat` 调用里显式附 `mode:"bare"`；bare 下沿用 flat 渲染（`onChatEventFlat`）与内存历史 `bareHistory`。
- 默认 activity 现为 `research`（schema.mjs DEFAULT 同步；开发项目不做旧 localStorage `agent.activity` 兼容）。

## 对账（reconcile）
- 默认**无自动对账**，offline 期间变更静默生效。
- 仅当用户在对话中**主动要求对账**，由 model 执行。

## 硬规则汇总（agent 层仅这两条 + presence 自动机）
1. presence 自动机：idle ≥10min 且无挂起 → out；插话 → in。
2. out 触发 supervised→autonomous（永久提权）。
3. autonomous 下 ask 自动 deny。
- 其余（activity 选择/跨域、对账、presence 微调）全交 model，agent 层只把当前 Mode 注入 system prompt 供参考。

## 高频组合态
| presence | autonomy | 含义 |
|---|---|---|
| in | supervised | 正常协作，每步可问 |
| in | autonomous | 人看着但代理自治（用户曾提权） |
| out | autonomous | 人离开+代理自治，ask 全 deny |
| in(回归) | autonomous(维持) | 人回来但代理仍自顾自干、不问他 |
| — | supervised(恢复) | 用户手动降权后 |

## 状态转移图
```
[presence: in] --idle≥10min且无挂起--> [presence: out]
      ▲                                  │
      │ 用户插话                          │ 自动触发
      │                                  ▼
      └─────────────────────── [autonomy: supervised]
                                    │
                                    │ 被迫自治(永久提权)
                                    ▼
                             [autonomy: autonomous]
                                    │ ask 自动 deny
                                    ▼
                          (自行决策 / 可跨 activity 含 build-code)

autonomous --用户显式切换模式按钮--> supervised   (仅此路径可逆)
```

## 最小实现参考
- `IDLE_TIMEOUT = 10*60` 秒；tick 检测 last_user_action 与 user_suspended。
- `on_user_interject()` 仅置 presence=in，不触碰 autonomy。
- `ask()` 在 autonomous 下返回 DENY，不阻断流程。
- Mode 对象注入 system prompt；activity 切换、跨 build-code、对账由 model 在 prompt 中自判。

## 设计取舍记录
- presence 作"推断状态"而非硬检测，允许 model 自调。
- autonomy 永久提权：人离开即自治，回来不自动恢复，仅显式降权才回 supervised，避免回来被频繁打断。
- ask 自动 deny 是 autonomous 唯一硬行为约束，保持 agent 层轻。
