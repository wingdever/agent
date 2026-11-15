# bash 工具权限策略层规划（Phase 2）

> 配套解析层见 `docs/tool/bash.md` 与 `tools/bash/parse/`（Phase 1 已完成）。
> 本文件是 **规划**，不含实现代码；实现前需用户确认本规划。

## 目标

在 Phase 1 产出的「与解析器无关的 IR」之上，实现策略引擎：
输入 IR，输出每个子命令（及整体复合命令）的 `allow / ask / deny` 决策 + 可解释理由。
策略层只做**权限门控（permission gate）**，不执行命令、不替代沙箱（见 bash.md §(4) 纵深分离）。

## 已确认的需求决策（来自需求澄清）

| 议题 | 结论 |
|------|------|
| 策略持久化 | 独立 JSON 策略文件（建议 `user/bash-policy.json`），与现有 per-tool `user/permissions.json` 并列，工具启动时加载 |
| 无匹配默认 | **全部默认 ask**（最保守；fail-closed 偏宽松但可用） |
| 匹配语法 | 先匹配程序名；有参数时再按子匹配规则（程序 + argv 前缀）匹配 |
| 集成方式 | Phase 2 先做**纯决策函数** `evaluate(ir) -> Decision`，暂不接入 `run.js` / UI |
| 分类 vs 规则优先级 | IR 的 read/write/network/mixed 分类作**基线**；用户规则可**覆盖**（如 `rm -rf`→deny 覆盖 write→ask） |
| 包装器处置 | **复合匹配**：`sudo rm` 优先匹配 `sudo rm` 规则，否则回退 `rm` 规则；**外层 deny 不削弱**内层 allow（外层 ask/deny 优先于内层 allow） |
| 动态构造 | 标记 `dynamic`；区分变量作命令 vs 作参数；部分变量可配权限匹配，其余表达为具体值再匹配；无匹配对象 → 默认 ask |
| 策略模式 | 单一标准模式，Phase 2 **不做**只读/标准/受信切换 |

## 与现有权限系统的边界

- `core/permissions.js`：是 **工具级** per-tool 门控（`bash` 工具整体 allow/ask/deny），基于 `user/permissions.json`。
- 本策略层：是 **命令级** 门控，作用于 `bash` 工具**内部**的每条子命令。
- 二者叠加：先过工具级（是否允许调用 bash），再过命令级（是否允许该具体命令）。命令级是更细的闸门，不重复工具级职责。

## 策略文件 schema（草案）

```jsonc
{
  "default": "ask",            // 无匹配时的默认决策；固定为 ask（按需求）
  "rules": [
    // 程序名匹配（基线，对应 IR 分类）
    { "match": { "program": "cat" },            "decision": "allow" },
    { "match": { "program": "rm" },             "decision": "ask"   },  // 写类基线已被分类覆盖，这里可省略或微调
    { "match": { "program": "curl" },           "decision": "ask"   },

    // 程序 + argv 前缀匹配（精确，无通配）
    { "match": { "program": "rm", "args": ["-rf", "/"] }, "decision": "deny",
      "reason": "refuse recursive delete at filesystem root" },

    // 包装器复合键：外层优先
    { "match": { "program": "sudo", "args": ["rm"] }, "decision": "deny",
      "reason": "no privilege escalation to rm" },

    // 变量作为命令的参数匹配（dynamic 具体化）
    { "match": { "program": "curl", "args": ["$URL"] }, "decision": "ask",
      "env": { "URL": "https://internal.example.com/*" } },

    // 显式放行受信 dynamic 模式（可选）
    { "match": { "program": "bash", "args": ["-c", "$BUILD_SCRIPT"] }, "decision": "allow",
      "env": { "BUILD_SCRIPT": "/repo/scripts/*.sh" } }
  ],
  "env": {
    // 全局 dynamic 变量白名单（可选）：未在具体规则内声明的 dynamic 变量可在此统一定义约束
    "SCRIPT_DIR": "/repo/scripts/*"
  }
}
```

匹配键说明：
- `program`：IR `SimpleCommand.program`（字面程序名；`$CMD` 类 dynamic 名为 `null`，单独处理）。
- `args`：argv **前缀**精确匹配（按顺序）；省略 `args` 表示只按程序名匹配。
- `env`：仅用于 dynamic 具体化——把 IR 标记为 dynamic 的参数/变量，若能在策略中表达为受约束的具体值（如 URL 白名单、脚本路径白名单），则按具体值参与匹配，否则回落默认 ask。
  - 规则级 `env`：写在单条规则内，约束该规则匹配用到的 dynamic 变量（如 `URL`、`BUILD_SCRIPT`）。
  - 全局 `env`：写在策略文件顶层（与 `default`、`rules` 并列），约束未在具体规则内声明的 dynamic 变量，供所有规则共享。
  - 值支持 glob（`*` 单段 / `**` 跨层）：`https://internal.example.com/*`、`/repo/scripts/*.sh`。
- `reason`：决策的可解释字符串，回传给审批 UI / 日志。

## 决策算法（evaluate）

对 IR 做深度优先遍历，对每个 `command` 节点计算 `decision`，再做**复合聚合**：

1. **单条命令决策 `decide(simple)`**：
   a. 若 `simple.dynamic === true`：
      - 尝试按策略中 `env` 约束把 dynamic 变量具体化为受信值；能完全具体化 → 继续按具体键匹配；
      - 无法具体化（或策略未声明）→ **ask**（除非命中显式 `deny` 规则）。
   b. 复合键优先：先查 `{program + 完整 argv 前缀}` 规则；未命中则查 `{program}` 规则；均未命中 → **default = ask**。
   c. **分类基线兜底**（仅当无用户规则命中时生效）：
      - `read` → allow；`write`/`network`/`mixed` → ask。
      - 用户规则一旦命中，覆盖分类基线。
   d. 包装器外层：若 `simple.wrappers` 含 sudo/docker 等，把 **外层程序名 + 内层程序名** 拼成复合键（如 `sudo rm`）优先查规则；命中 deny/ask 直接采用（外层不削弱）；无复合规则则回退内层 `rm` 规则。

2. **复合命令聚合**（参照 bash.md §(3) + Claude Code 逻辑）：
   - 遍历 `pipeline / andor / subshell / bracegroup / redirect` 的子节点；
   - 任一子节点 `deny` → 整体 **deny**（短路，记录首个 deny 来源）；
   - 否则任一 `ask` → 整体 **ask**；
   - 全部 `allow` → 整体 **allow**；
   - `compound`（if/for/while/case/function）节点自身已标 `dynamic` → 至少 **ask**（fail-closed）；
   - `unreliable === true`（unbash 有 errors）→ 整体至少 **ask**，绝不 allow。

3. **输出 `Decision`**：
   ```js
   {
     overall: "allow" | "ask" | "deny",
     commands: [ { program, raw, decision, reason, range } ],  // 每个子命令明细
     firstDeny: { ... } | null,
     requiresApproval: boolean,   // overall === "ask"
     blocked: boolean,            // overall === "deny"
   }
   ```

## 模块结构（实现时）

```
tools/bash/policy/
  schema.mjs     # 策略文件加载 + 校验 + 回退（损坏/缺失 → default=ask）
  match.mjs      # 复合键匹配、argv 前缀匹配、dynamic 具体化（env 约束）
  evaluate.mjs   # evaluate(ir, policy) -> Decision（单条决策 + 聚合）
  index.mjs      # 入口 export evaluate, loadPolicy
```

- 复用 Phase 1 的 `parseCommand`（`tools/bash/parse/index.mjs`）与 IR 字段
  （`program`, `argv`, `wrappers`, `dynamic`, `readWrite`, `raw`, `range`, `dynamicSubcommands`）。
- 不修改 `tools/bash/run.js`（Phase 2 纯决策函数，集成留到后续阶段/Phase 3）。
- 与 `unbash` 同为 ESM，`index.mjs` 供 CJS 侧 `await import()` 调用。

## 测试用例规划（实现时）

- 程序名基线：`cat`→allow，`rm`→ask（分类基线）。
- 参数前缀覆盖：`rm -rf /`→deny（覆盖 write→ask）。
- 包装器复合键：`sudo rm`→deny（外层优先）；`sudo ls`→（无复合规则）回退 `ls`→allow。
- 外层不削弱：`sudo rm`（仅有 `rm`→allow 规则时）→ 仍因外层 sudo 复合 deny 而 deny。
- 动态变量具体化：`curl $URL` 且策略含 `URL` 白名单命中 → 按具体值匹配；否则 ask。
- 聚合：`ls | grep x` 全 allow → allow；`cat && rm -rf /` → deny；`echo a || sudo rm` → ask/deny 取严。
- fail-closed：`unreliable` IR → 整体至少 ask，不 allow；`if true; then ...` compound → ask。
- 分类兜底：`curl`（network，无规则）→ ask。

## 不在 Phase 2 范围

- 接入 `run.js`、UI approval 卡片（Phase 3 或后续集成阶段）。
- 只读/标准/受信多模式切换（需求确认不做）。
- 沙箱耦合（**本 agent 不实现沙箱**；策略层只产决策，能力限制由宿主环境兜底，见 docs/tool/bash.md "范围声明"）。
- 通配/正则匹配（需求确认 Phase 2 仅精确前缀；通配留待评估）。

## 验收标准（实现时）

给定一组涵盖「程序基线 / 参数覆盖 / 包装器复合 / 动态具体化 / 复合聚合 / fail-closed」的测试命令，
`evaluate(ir, policy)` 稳定输出正确的 `overall` 决策与逐子命令明细，且决策可解释（带 reason）。

## 已确认的设计决策（用户拍板）

- **外层 deny 语义**：接受「外层 deny/ask 不削弱内层 allow」。即便存在 `rm`→allow 规则，只要 `sudo rm` 被 deny 规则命中，整体仍为 deny。依据：用户确认"复合匹配 + 外层优先"（见上表"包装器处置"）。
- **文件名/位置**：策略文件定为 `user/bash-policy.json`，与现有 per-tool `user/permissions.json` 并列；模块目录 `tools/bash/policy/`。

以上两点已冻结，实现时不再变更。规划冻结后，按 AGENTS.md 规则需用户最终 check ok 方可进入 `tools/bash/policy/` 实现（Phase 2 纯决策函数，不接 `run.js`/UI）。
