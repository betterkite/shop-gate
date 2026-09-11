# Shop Gate commerce-data

这是 Shop Gate 零售 Data Agent 的数据服务，承载 UserBehavior 事件、商品/类目主数据和日聚合查询。金额、价格、库存、品牌与店铺字段均按项目约定的真实/合成边界返回；合成字段由响应中的 `synthetic_fields` 标注。

## 运行

要求 Python 3.14 和 `uv`：

```bash
cd services/commerce-data
uv sync
uv run shopgate-commerce-api
```

API 默认监听 `http://127.0.0.1:8000`。服务只读取自身需要的环境变量：`DATABASE_URL`、`REDIS_URL`、`REDIS_NAMESPACE`、数据库/Redis 降级开关和监听地址。Redis 不可用时只影响缓存与就绪状态，不会改变零售数据口径。

## 导入

`shopgate-commerce-import` 是零售数据的唯一离线导入入口：

```bash
uv run shopgate-commerce-import import-userbehavior --csv /path/to/UserBehavior.csv
uv run shopgate-commerce-import generate-synthetic-behavior
uv run shopgate-commerce-import generate-synthetic-master
uv run shopgate-commerce-import aggregate-daily
```

真实 UserBehavior 事件写入 `commerce.user_behavior_events`；合成商品、品牌、店铺和类目主数据写入 `commerce.*`；商品/类目日聚合写入 `commerce.daily_*_metrics`；P27 扩展经营分析数据集写入带 `dataset_id` 的 `commerce.dataset_*` 表。详细字段和重跑语义见项目根目录的 [commerce-data 接入说明](../../docs/commerce-data-ingestion.md) 与 [数据字典](../../docs/data-dictionary.md)。

## API

- `GET /health`：进程存活检查。
- `GET /ready`：数据库与 Redis 就绪检查。
- `GET /api/v1/commerce/meta`：数据窗口、来源和规模。
- `GET /api/v1/commerce/datasets`：扩展经营分析数据集的版本、来源、合成字段和限制。
- `POST /api/v1/commerce/datasets/import`：异步生成隔离的合成经营分析数据集并执行质量扫描；请求返回任务 ID。
- `POST /api/v1/commerce/datasets/import/csv`：上传标准五列行为事件 CSV，保留行为来源，并为价格、成本、渠道、订单和库存补充字段标记合成口径。
- `GET /api/v1/commerce/datasets/import/{job_id}`：查询生成任务状态、进度、质量扫描结果和失败原因。
- `GET /api/v1/commerce/datasets/import`：列出最近的数据集生成任务，支持 `dataset_id` 和 `limit` 过滤。
- `GET /api/v1/commerce/analytics/item-behavior`：按数据集返回商品级 PV、收藏、加购、购买和购买转化。
- `GET /api/v1/commerce/resolve`：商品/类目实体解析。
- `GET /api/v1/commerce/capabilities`：零售能力发现。
- `GET /api/v1/commerce/funnel`、`/funnel/daily`：流量与转化漏斗。
- `GET /api/v1/commerce/categories/top`、`/items`、`/items/{item_id}/daily`：类目和商品结构。
- `GET /api/v1/commerce/inventory-risk`：库存风险 Top N（库销比）以及覆盖全量商品的库存健康 `health` 汇总。
- `GET /api/v1/commerce/channels`：渠道聚合。
- `GET /api/v1/commerce/summary`：经营日报快照。
- `GET /api/v1/commerce/analytics/overview`：扩展数据集经营概览。
- `GET /api/v1/commerce/analytics/rfm`：用户购买新近度、频次和金额分群（RFM）。
- `GET /api/v1/commerce/analytics/channel-campaign`：渠道/活动会话、订单和转化。
- `GET /api/v1/commerce/analytics/profit`：合成成本下的销售额、退款、毛利和毛利率。
- `GET /api/v1/commerce/analytics/inventory`：库存结存、日销量、可售天数和库存健康标签。
- `GET /api/v1/commerce/analytics/lifecycle`：按窗口内购买活跃度判断商品经营阶段；支持 `stage` 阶段筛选、`page` 分页和 `limit` 每页数量。
- `GET /api/v1/commerce/analytics/price-elasticity`：价格带对比；数据不足时明确不返回弹性系数。
- `GET /api/v1/commerce/analytics/drilldown`：按用户、渠道、活动或商品继续查看上下文，并返回下一步问题建议。

API 详情以项目根目录的 [API 总览](../../docs/api-reference.md) 为准。

## 代码边界

- `api.py`：FastAPI app factory、健康与就绪端点。
- `cli.py`：API 启动和环境变量白名单。
- `import_cli.py`：UserBehavior、合成数据和日聚合导入。
- `routers/commerce.py`：唯一 HTTP 领域路由。
- `retail.py`：零售查询和纯计算函数。
- `synthetic.py`：可复现的合成主数据/行为生成器。
- `database_core.py`：PostgreSQL/TimescaleDB 连接和共享数据转换。
- `cache.py`：可选 Redis JSON 缓存。
- `readiness.py`：数据库与 Redis 的依赖就绪策略。

旧股票行情、回测、财务、provider、ClickHouse 和研究模块已从本服务移除；新的零售能力直接落在 `retail.py` 与 `commerce` SQL 表上。
