# dsh

## 范围
从 DSH 借鉴的通信契约与实现对照。本目录分两层。

## 两层

| 层 | 目录 | 写什么 | 维护方式 |
|---|---|---|---|
| 原型 | [`prototype/`](prototype/communicate-contract.md) | **以 DSH 线上实现为准的参照原型**：DSH 怎么组装提示词、怎么发布工具、怎么走消息与线上格式 | 由脚本从 `reference/deepseek-harness` 源码抽取，可重新生成 |
| 实现 | [`achievement/`](achievement/README.md) | 本项目怎么实现：哪些已实现、哪些没实现、哪些与原型有差异、哪些是明确差异 | 人工维护，以当时的代码为准 |

两层的文件一一对应。原型层是定义性的参照，实现层逐篇对照；原型里找不到落点的独有设计写在 `achievement/additional/`。

## 阅读顺序

先读实现层的总览（`achievement/README.md` 的对照表），再按需读对应的原型文档。
