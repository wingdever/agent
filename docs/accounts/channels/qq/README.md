# QQ 机器人 channel

QQ 官方机器人驱动（`channels/qq/`）：走 WebSocket 长连接，凭据为轮换的 `access_token`，事件经平台推送，不需要公网入口。

- [架构](arch.md) — 分层位置、装配入口、驱动构成、能力画像、交互状态、运行流程、出站协议、测试
- [数据结构](data.md) — 入站消息、出站消息、字段对接关系
- [通信方式](conn.md) — 入站模式分类、平台双模式、QQ 的选择与风险、WebSocket 生命周期、出站 REST
- [微服务设计](microservice.md) — 目标与边界、总体架构、单一数据源、与 core 的交互、实施顺序、实现决策
- [部署](deployment.md) — 双进程组成、配置、systemd unit、fake 验证命令
- [dedupe 评估](dedupe-evaluation.md) — JSON dedupe 的实测缺陷与三方案对比，推荐原子写
- [待办](todo.md) — 剩余缺口与待评估项
