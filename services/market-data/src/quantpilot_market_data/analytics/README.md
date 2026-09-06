# Analytics Boundary

`analytics/` 是 ClickHouse 等分析加速组件的 Adapter 层。

职责：

- 管理 ClickHouse 初始化、同步、健康检查和只读分析查询。
- 承接 append-only 的宽表、评测事件、生成事件和大规模筛选。
- 在不可用时向 service 层返回明确降级原因。

设计约束：

- ClickHouse 不是事实主库，不替代 TimescaleDB/PostgreSQL。
- 不承载需要事务一致性的业务状态。
- 查询失败必须能回退到 TimescaleDB 或返回可解释的 degraded 状态。

当前 ClickHouse HTTP 入口已落到 `routers/analytics.py`，业务编排落到 `services/analytics.py`，底层 ClickHouse adapter 仍保留在 `clickhouse.py`。后续新增分析能力优先落到本目录或同类 adapter，再由 service 编排。
