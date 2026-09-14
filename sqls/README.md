# Shop Gate SQL Bootstrap

`sqls/` 保存 Shop Gate 组件第一次使用时需要的基础数据库对象。所有 SQL 都应保持可重复执行，方便 Docker 首次建库、已有本地库补齐和后续部署检查。

## 执行顺序

| 文件 | 组件 | 说明 |
| --- | --- | --- |
| `001-commerce-timeseries.sql` | TimescaleDB / commerce schema | 创建 TimescaleDB 扩展、`commerce` schema、真实用户行为事件流（天池 UserBehavior 抽样）与商品/类目日聚合表 |
| `002-commerce-catalog.sql` | 商品主数据 | 合成 SKU 档案（价格/库存/品牌/店铺）与类目表；`category_id`/`item_id` 继承真实行为流，合成字段带标注（PRD §5.2） |
| `003-commerce-platform.sql` | 平台基础组件 | 数据导入任务、同步水位、数据质量扫描和通用平台任务表（已按零售 schema 落地） |
| `004-commerce-analytics-contract.sql` | 经营分析数据契约 | 追加式扩展数据集契约，以及用户、会话、渠道、活动、订单、商品经济、库存快照、价格实验观察和用户级分组证据表；所有数据集按 `dataset_id` 隔离 |
| `005-commerce-analytics-orchestration.sql` | 经营分析跨服务编排 | 为导入/看板任务增加 `project_id` 与幂等键，并提供可重试的分析编排事件 outbox |

主业务表由 Prisma 维护，不在这里手写：

| 组件 | 表 |
| --- | --- |
| 项目与对话 | `projects`、`messages`、`sessions`、`tool_usages`、`user_requests` |
| 环境与集成 | `env_vars`、`service_tokens`、`project_service_connections`、`commits` |
| 平台配置 | `platform_settings` |
| 经营情报 | `brief_watch_pools`、`operation_briefs`、`operation_brief_runs` |
| 评测平台 | `eval_runs`、`eval_queue_items`、`eval_repair_tickets`、`eval_schedules` |

## 本地初始化

首次使用推荐：

```bash
npm run db:up
npm run db:init
npm run db:doctor
```

`npm run db:init` 会按顺序执行 `sqls/*.sql`，然后运行 `prisma db push` 同步 Prisma 管理的应用表。已有数据库也可以重复执行该命令。

表字段、来源和页面使用位置见 [数据字典](../docs/data-dictionary.md)。真实/合成口径标注见 PRD §5；如果新增 SQL 表或字段，需要同步更新这里和数据字典。

## 规则

- SQL 必须使用 `IF NOT EXISTS` 或等价方式，避免重复执行失败。
- 行为事件流与聚合表放在 `commerce` schema。
- 真实数据（行为流、类目/商品 ID）与合成数据（价格/库存/品牌/店铺）必须在表注释和字段标注中可区分（PRD §5.3 红线）。
- 扩展分析数据必须携带 `dataset_id`、`source`、`synthetic`；`dataset_contracts` 必须记录版本、窗口、生成规则和限制。
- P32 编排任务必须同时携带 `project_id` 和 `idempotency_key`；事件消费者只读取自己项目的未确认事件，并通过 `consumed_at` 确认处理，不能从浏览器当前页面或最近项目猜测目标项目。
- 平台主业务表继续先改 `prisma/schema.prisma`，再通过 Prisma 生成数据库结构。
- 后续若引入 Redis、对象存储或列式分析，只把 PostgreSQL/TimescaleDB 相关 SQL 放在这里。
