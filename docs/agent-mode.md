# Agent Mode Design

## 核心模型：三轴正交

```
Mode = {
  presence:   in | out
  autonomy:   supervised | autonomous
  activity:   bare-chat | goal-plan | build-code | discuss-doc | research | review-proj | human-learn | diagnose
}
```
- 三轴**正交**，不是平铺枚举。presence 是元状态，跨所有 activity 共享同一套机制。
- `risk` 轴**暂不使用**（避免过度设计，日后若 autonomous 出乱子再考虑加回）。

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
- 八类：`bare-chat / goal-plan / build-code / discuss-doc / research / review-proj / human-learn / diagnose`。
- 代理**可跨 activity**，含跨到 `build-code`（落盘变更）；信任 model 自行判断。
- 只读倾向类：research / goal-plan / discuss-doc / review-proj / human-learn / diagnose；落盘类：build-code。`bare-chat` 为轻量对话（不落库、不支持工具调用）。边界由 model 把握。
- **流转模型（UI 层）**：`activity` 是**建会话时选定的初始活动**，运行后可切换，非锁定。
  - 一个活动**完成后**可自然进入其它活动（如 `goal-plan` 经 `exit_plan_mode` 批准后自然进入 `build-code`）。
  - 活动**未完成**时也可**强制切换**，但需**二次确认**防误操作：supervised 下弹内联确认窗（提示将中断进行中的工作、plan-mode 策略即时失效），autonomous 下直接切换（人不干预，与 ask 自动 deny 一致）。
  - 完成态由 model 上报（如 plan 批准），UI 在活动指示器上以 `✓` 标注。详见 `docs/dsh/dsh-replica.md`。

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
