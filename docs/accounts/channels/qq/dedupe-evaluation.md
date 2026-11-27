# dedupe 事务性存储迁移评估

## 现状

`channels/inbound/dedupe.js` 用内存 Map + JSON 文件（`data/channels/dedupe-<id>.json`）：

- 每次 `claim()` 后 `persist()` 全量重写 JSON
- 容量 2000、TTL 24h，`load()` 时 prune
- `load()`/`persist()` 都有 best-effort catch

## 实测结论

**性能不是问题。** 2000 条 × 100 次全量重写实测 18ms（单次 0.18ms）。QQ bot 消息频率远低于此，不构成迁移理由。

**原子性是真缺陷。** `fs.writeFileSync` 中途崩溃会留下截断的 JSON；`load()` 的 catch 降级为空 Map，导致 24h 内所有重投被当新消息重复处理。实测确认截断文件无法解析。

**并发不是问题。** channel 服务有实例锁（`channel-run.js:66` 的 `run-<id>.lock`），单进程持有一份 Map，无多写者竞争。

## 方案对比

| 方案 | 做法 | 收益 | 代价 |
|---|---|---|---|
| A. 不动，加原子写 | `persist()` 改为写临时文件 + rename | 消除截断损坏，零新依赖 | 仍是全量写（可接受），不改共享层契约 |
| B. 迁到现有 DuckDB | 在 `history-<id>.duckdb` 加 `dedupe` 表，用 INSERT OR IGNORE | 事务性、查询友好、与消息历史同库 | 改共享层 `createDedupe` 接口（异步化），影响所有 channel 驱动 |
| C. 换成 SQLite | 独立 `dedupe.db` | 事务性、同步 API | 引入新依赖和第二个 DB 文件 |

## 推荐：方案 A

理由：

1. **收益覆盖真实风险**：临时文件 + rename 是原子操作，崩溃只会留下旧文件或新文件，不会截断。这解决了实测出的唯一缺陷。
2. **不动共享层契约**：`createDedupe` 的 `claim()` 是同步的，`manager.js`/`pipeline.js` 都依赖这个同步语义。迁 DuckDB 要把它改成异步，影响所有 channel 驱动（QQ/飞书/云湖/fake），收益不匹配。
3. **无新依赖、无第二 DB**：方案 B 虽然复用现有 DuckDB 文件，但 `dedupe` 属于所有 channel 共享的入站层，把它塞进 QQ 的 `history-<id>.duckdb` 在概念上错位——飞书/云湖实例没有这个文件。

方案 A 已实施（`channels/inbound/dedupe.js`）：

```js
function persist() {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: [...seen] }));
  fs.renameSync(temp, file); // atomic on same filesystem
}
```

新增测试 `test/channels/inbound/dedupe.test.js` 验证：写入后主文件完整、无残留 `.tmp`、新实例能读到完整状态。

若将来出现多实例共享 dedupe 的需求（当前被实例锁排除），再考虑方案 B，且应把 dedupe 表放进独立的共享存储，不是 QQ 的 history 库。
