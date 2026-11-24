# accounts

外部账号接入的设计枝：`channel`（机器人账号）与 `proxy`（自然人账号代理）两个插槽，以及它们共用的基础层。

范围：两类钥匙的区分、凭据生命周期、错误分类、出站节奏、实例发现与配置、最小权限。

不在此枝：core 的 turn 语义与落库（见 `docs/foundation/architecture.md`）、调用界面（见 `docs/foundation/transport.md`）、本机界面与启动（见 `docs/ui/`）。
