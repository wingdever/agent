# 实现层说明

本目录记录本项目（`/home/wing/Projects/agent`）对 DSH 通信契约的实现状态：哪些已经实现、哪些没有实现、哪些与原型有差异、哪些是我们明确做出的差异；也记录不按单篇原型对照的横切产品化评估。

## 与原型层的关系

- **原型层**（`../prototype/`）是**以 DSH 线上实现为准的参照原型**，由脚本从 `reference/deepseek-harness` 源码抽取，可重新生成。
- **实现层**（本目录）是**人工维护**的对照，条目以当时的代码为准；代码改了这里不会自动更新，需要同步维护。

原型层与实现层的 DSH 对照文档一一对应，例如 `achievement/system-prompt.md` 对应 `prototype/system-prompt.md` 与 `prototype/runtime-context.md`；横切评估不参与这种对应。

## 七类关系

每一节的"与原型的关系"按以下七类标注：

| 类别 | 含义 |
|---|---|
| **已对齐** | 行为与原型一致 |
| **实现差异（已决定）** | 我们没按原型做，但这是**明确做出的差异**，不计划改 |
| **待对齐** | 我们没按原型做，**计划改** |
| **未实现** | 原型有、我们还没有 |
| **明确不做** | 原型有、我们**明确不做**（例如沙箱） |
| **暂不做** | 原型有、我们暂时不做，但已排进未来里程碑（例如多用户 M9） |
| **我们独有** | 原型没有、我们额外做的（详细条目见 `additional/`） |

## 已编写与待编写

| 文档 | 对应原型 | 状态 |
|---|---|---|
| [`system-prompt.md`](system-prompt.md) | `prototype/system-prompt.md`、`prototype/runtime-context.md` | 已编写 |
| [`tools.md`](tools.md) | `prototype/tools/` | 已编写 |
| [`workflow.md`](workflow.md) | `prototype/workflow.md`、`prototype/tools/workflow.md` | 已编写 |
| [`capability-gap.md`](capability-gap.md) | 55 个能力组总览 | 已编写 |
| [`maturity-gap.md`](maturity-gap.md) | 跨能力产品化差距（非单篇原型） | 已编写 |

实现层按需编写，不预先覆盖全部原型文档。每份 DSH 对照文档固定三节：

1. **当前实现**：我们实际的代码行为，标明文件路径；
2. **与原型的关系**：按七类逐条对照；
3. **后续计划**：待对齐项与不计划改动的项。

横切评估（如 [`maturity-gap.md`](maturity-gap.md)）按主题组织，不套三节结构；它回答“离成熟、易用还差什么”，不逐项对照原型。

## additional

原型里找不到对应落点的、本项目独有的设计，写在 `additional/` 下。目前为空。
