


interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

# 范围声明（重要）

**本 agent 不实现沙箱（sandbox）。** 这与 AGENTS.md 第 7 条规则一致：tools 始终直接作用于真实系统，不设计沙箱分支，也不暴露任何 sandbox-facing 字段（如 `sandbox_permissions`、`justification` 在权限层不被使用）。

权限边界只有一层：**解析层 → 策略引擎（allow / ask / deny 门控）**。该门控是"permission gate, not a sandbox"——它负责减少不必要的审批噪音、拦截明显不匹配的策略，**不证明命令绝对安全**。真正的危险操作（文件系统、网络、进程能力）由宿主操作系统与运行环境兜底，不在本 agent 的职责内。

因此：
- `sandbox_permissions`、`justification` 字段在本 agent 中**不实现、不解析、不生效**（仅为兼容外部协议保留在接口描述中）。
- Phase 3 规划中"接入沙箱作为纵深防御"在本 agent 中**不做**；策略层与沙箱的"纵深分离"在本 agent 内体现为"门控 + 宿主环境兜底"，而非引入沙箱实现。
- 任何要求"按更宽松沙箱模式重试"（如 `bash.md` 中描述的 escalation 重试）的流程，在本 agent 中不适用——命令要么被允许/审批通过，要么被拒绝，没有中间的沙箱放行通道。

function bashDescription(backgroundEnabled: boolean, escalationModes: readonly SandboxMode[]): string {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const base = 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
    + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
    + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
    + `Current harness environment facts are exposed through managed \`$${DSH_ENV_PREFIX}*\` variables; inspect them when needed. `
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
  if (escalationModes.length === 0) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the '
    + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
    + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
    + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
    + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
    + 'approval prompt raised by that retry is how the user consents. If the session states approval '
    + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
    + 'Never escalate speculatively: ground the request in a real denial — normally the one this command '
    + 'just hit; escalating up front is fine only when this session already denied the same access. '
    + 'A rejected escalation is final for that command — stop and explain, never work around '
    + 'it — but it does not forbid attempting or escalating other commands later.'
}


type BashCallArgs = { 
    command: string; 
    description: string; 
    workdir?: string; 
    run_in_background?: boolean 
}

# AST解析 -> 中间表示 -> 子命令拆分 -> 逐项权限判断(权限策略)
## 1. 解析层: from 命令行字符串 to 结构化子命令图
解析层输出不是直接权限决策，是与策略无关的命令结构中间表示（IR）。
先用unbash实现，轻量且已被dsh选型。
需要提取的信息至少包括：
1. 子命令列表：
  每个 simple command 的程序名、参数、赋值前缀、源码区间。
2. 逻辑关系：
  管道（|）、逻辑与/或（&& / ||）、顺序执行（; / 换行）、
  后台执行（&）、子 shell（(...)）、命令组（{ ...; }）、
  命令替换（$(...) / `...`）、进程替换（<(...) / >(...)）
3. 重定向：
  目标路径、操作符类型（读/写/追加/文件描述符复制）
4. 包装器标记：
  当前子命令是否是一个“启动器”或“解释器”，
  例如 
    sudo、env、xargs、nohup、timeout、nice、
    bash -c、sh -c、eval、docker run、find -exec 等
5. 动态构造标记：
  是否存在无法静态解析为字面量的命令名或参数
  （如变量展开、命令替换产生的参数、eval 的字符串参数）
6. 安全环境变量剥离后的有效命令：
  例如 NODE_ENV=prod npm run build 在权限匹配时应视为 npm run build，
  但 LD_PRELOAD=evil.so curl 中的赋值不能无条件剥离。
7. 区分读命令和写命令：
  往往是写命令需要ask,读命令则allow.

## 2. 中间表示: present 逻辑关系 by 树结构
一个建议的 IR 形态可以借鉴 @aliou/sh 的节点模型：
Program → Statement → Pipeline / Logical / SimpleCommand 等。
对于权限判断，关键是在 IR 中显式标注控制流边和数据流边：
1. 管道 a | b：
a 的 stdout 流入 b 的 stdin。
权限上二者都必须检查，但可以区分“只读生产者”与“消费者”的额外语义。
2. a && b / a || b：
b 是否执行取决于 a 的结果。
权限上仍然必须对 a 和 b 都做检查（不能因为 a 失败就假设 b 不会执行），
但可以在 UI 审批时展示条件关系。
3. 子 shell / 命令组：
内部命令作为一个整体单元参与权限聚合。
4. 命令替换 / 进程替换：
内部命令是实际会执行的命令，必须递归进入权限检查，不能当作普通参数忽略。
bashcage 的设计是直接阻断命令替换、进程替换、子 shell 等构造，
而不是尝试分析它们，因为“拒绝是构造性的，不需要维护黑名单”。
这是一个值得借鉴的安全姿态：
对于无法可靠静态分析的动态构造，默认拒绝或触发人工审批，而不是猜测。

## 3. 权限策略层：独立于解析的规则引擎
权限层只消费 IR，不关心 IR 是由 tree-sitter、unbash、mvdan/sh 产生的。
可以替换解析器而不影响策略，也可以对同一份 IR 运行不同的策略集
（只读模式、标准模式、受信模式）。
权限层需要处理几个关键决策：
（1）子命令的匹配粒度
pi-access-guard 的做法是提取子命令（包括链、管道、子 shell），
展开包装器（sudo、time、npx），
然后对每个子命令做规则匹配，最终决策为 allow / ask / deny 之一。
cmdpolicy 则更进一步：
它把二进制按类别分类（read-fs、read-system、mixed、network、denied），
read-* 无条件放行，
mixed / network 按参数做 ReadOnlyMatchers / WriteMatchers，
例如区分 iptables -L 和 iptables -A。
（2）包装器的递归展开
这是安全绕过的高发区。
sudo rm -rf / 如果只匹配外层命令 sudo，
一条 "rm *": "deny" 的规则就会被绕过。
runok 的做法是识别 sudo、bash -c、xargs 等包装器，递归求值被包裹的命令；
并且明确 deny/ask on wrapper 不被削弱，
即外层包装器的 deny 优先于内层的 allow。
建议在 IR 中把包装器建模为“透明节点”：
权限引擎在遍历时“穿透”包装器，
同时对包装器本身也施加约束
（例如 sudo 本身可能需要单独的 privilege 策略）。
（3）决策聚合规则
对于复合命令，常见的安全聚合是：
任一子命令 deny → 整体 deny；
任一子命令 ask → 整体 ask；
全部 allow → 整体 allow。
Claude Code 的复合命令权限聚合正是这一逻辑。
需要额外考虑的是“不可解析”的默认处置：
bashcage 和 Claude Code 都选择
将无法可靠解析或过于复杂的构造导向 ask 或 deny，
而不是 allow——这是 fail-closed 的姿态，对于自动权限控制是必要的。
（4）策略与沙箱的纵深分离
cmdpolicy 的设计值得参考：
policy 层决定“是否允许某个命令”，
sandbox 层决定“在什么隔离边界内执行”。
两者解耦，未来不同的工具可以组合不同的 Policy 和同一个 Sandbox runner。
对于你的目标，这意味着权限引擎不需要承担“命令绝对安全”的证明责任；
它只需要在策略层面做出 allow/ask/deny，真正的危险操作由沙箱兜底。

# 结构性难题
1. 动态命令构造：
问题：
eval "$USER_INPUT"、bash -c "$(curl ...)"、变量作为命令名（$CMD arg）等，无法在静态解析阶段确定实际执行的命令。
建议：
标记为 dynamic，先区分变量作为命令还是作为参数，
对一些变量设有权限匹配，另一些则表达为具体值再进行权限匹配，
最后没有匹配对象的则默认触发 ask。
2. 解释器与启动器：
问题：
python -c、node -e、perl -e、docker run、find -exec 等，其参数本身就是代码或子命令。bashcage 的教训是：允许一个启动器等于允许它能被“论证”去做的一切，docker * 或裸 docker 永远无法钉死你真正想授权的子命令。
建议：
要求按精确子命令授权。
经由其他专用工具调用相应启动器。
描述任务和参考命令交由用户手动操作。
3. 解析器的“部分失败”：
问题：
tree-sitter-bash 存在已知的语法覆盖缺口，
例如 heredoc + 2>&1 + pipe 的组合可能无法被干净解析。
建议：
解析器返回“部分 AST”或“错误节点”时，
权限引擎必须将其视为不可靠，不能当作“没有发现子命令”而放行。
unbash 也明确说 malformed input 返回 best-effort partial AST，
安全消费者必须检查 errors。

# 实现阶段
1. 第一阶段：
选择一个面向结构分析的解析库（TypeScript 栈优先考虑 unbash，Go 栈考虑 mvdan/sh），定义一份与解析器无关的 IR schema。IR 中必须包含子命令树、逻辑关系边、重定向、包装器节点、动态构造标记和源码区间。这一阶段的验收标准是：给定一组涵盖管道、&&/||、子 shell、命令替换、重定向、包装器的测试命令，IR 能稳定、可解释地还原出实际会执行的命令序列。

2. 第二阶段：
在 IR 之上实现权限引擎。先支持最基本的“程序 + 子命令前缀”匹配，然后逐步加入包装器递归、安全环境变量剥离、路径参数提取、决策聚合。策略的表示形式可以参考 vendor-neutral 的 allow / ask / deny 三元组模式，便于未来跨 Agent 迁移。

3. 第三阶段：
把“不可解析/过于复杂/dynamic”的处置策略固化为 fail-closed 规则。**沙箱接入不在本 agent 实现范围内**（见上文“范围声明”）：本 agent 只做解析层 + 策略门控，纵深防御由宿主操作系统与运行环境提供，不引入沙箱实现。权限引擎本身不是唯一的安全边界——Claude Code 明确说它的命令解析是一个“permission gate, not a sandbox”：权限门控负责减少不必要的审批噪音、拦截明显不匹配的策略，真正的能力限制由宿主环境兜底，二者分工而非互相替代。