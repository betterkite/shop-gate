# 零售域事实基线（docs 零售化重写的唯一依据）

> 用途：docs 内容零售化时的**事实核对清单**。重写任何文档段落前，先核对该描述是否与下表一致；下表没有的能力/端点/结构一律不得保留为"现状描述"。

## 1. 项目定位

Shop Gate 是**零售电商领域的 Data Agent 工作台**：运营者/分析师用自然语言提出经营问题，Agent 组合零售领域知识（商品/类目/流量/转化/库存）、真实行为数据与 Skills，生成可运行、可追溯的经营 dashboard。

- 蓝本：QuantPilot（MIT，金融域）——只作为**出处记录**（PROVENANCE.md/PRD 来源说明/归档横幅），不作为现状描述。
- 金融域已随 P3 移除；`benchmarks/` 金融数据已随 P0 删除。

## 2. 零售数据（唯一事实库）

- 数据源：天池淘宝 UserBehavior（dataset 649），公开镜像切片，**保留原始窗口 2017-11-25 ~ 2017-12-03**（`--time-shift none`）。
- 落库（`commerce.*`，PostgreSQL/TimescaleDB :5432/shopgate）：
  - `user_behavior_events`：1,013,367 事件 / 10,000 用户 / `source='tianchi_userbehavior'`
  - `items` 412,130、`categories` 5,922、`brands` 200、`shops` 500（tier: standard/premium/flagship）
  - `daily_item_metrics` 687,562、`daily_category_metrics` 30,644
  - 平台表：`platform_jobs`、`market_data_ingestion_jobs`、`market_data_sync_state`、`data_quality_scans`
- 行为类型：`pv`(曝光) / `fav`(收藏) / `cart`(加购) / `buy`(购买)
- **合成口径**：价格/库存/品牌/店铺为合成主数据；`gmv = buy 事件数 × 合成价格`；金额处必须带"合成口径"标注。

## 3. 数据接入（导入 CLI 与连接器）

`shopgate-commerce-import`（services/commerce-data，console 脚本）：
- `import-userbehavior --csv <path> [--users 10000] [--seed 20251203] [--time-shift none|last-week]`
- `generate-synthetic-behavior`、`generate-synthetic-master`、`aggregate-daily`
- 事件 CSV 契约：表头严格 5 列 `user_id,item_id,category_id,behavior_type,timestamp`（Unix 秒）
- provider 书签：`market_data_ingestion_jobs` / `market_data_sync_state`
- 文档入口：`docs/commerce-data-ingestion.md`

## 4. 数据后端 API（services/commerce-data，:8000）

`GET /api/v1/commerce/`：
`meta`、`resolve`、`capabilities`、`funnel`、`funnel/daily`、`categories/top`、`items`（分页/类目/排序）、`items/{id}/daily`、`inventory-risk`、`channels`、`summary?date=`

关键数据：
- `/meta`：first_event_ts=2017-11-25T00:00:00Z、last_event_ts=2017-12-03T16:00:06Z、user_count=10000、behavior_source=tianchi_userbehavior
- `/items`：total=412,130，支持 page/page_size(≤100)/category_id/sort(gmv|pv|buy|price)
- `/channels`：standard/premium/flagship 三档聚合（gmv_share ≈ 0.35/0.34/0.32）
- `/summary?date=2017-12-03`：GMV ¥1,198,069.97、曝光 110,710、购买 2,452、转化 2.21%、客单价 ¥488.61

## 5. 零售 Domain Pack（src/lib/domains/retail/**）

- 默认 Profile：`shopgate.retail-ops`；domain：`retail.core`；deliveryPack：`workspace.next-dashboard`
- 4 能力：`traffic_funnel`、`catalog_structure`、`price_inventory`、`daily_brief`
- agent-tools×6（含 `commerce_extract_uploaded_image`、`apply_dashboard_spec`、`commerce-data-registry` 等）
- 模板四套（多面板）：catalog-structure / funnel-analysis / price-inventory / daily-brief

## 6. 生成管线（零售）

Query Rewrite（DeepSeek LLM，`selectedModel=deepseek-v4-flash` 裸模型名）
→ Run Plan（`.data-agent/retail-run-plan.json`，含 window/capabilityId/visualization.templateId）
→ Data Prefetch（`retail-data-prefetch.ts` 调 commerce-data API；窗口动态取自 /meta）
→ 标准看板生成（`writeRetailDashboardTemplate` 按能力分发，多面板 SVG）
→ 自动验证（build/HTTP200/数据文件/evidence/产物契约/图表/entity-scope/视觉）
→ 证据验收 → receipt → 持久预览（next-server 动态端口）

**注意**：工作区文件为 `retail-run-plan.json` / `retail-query-rewrite.json`（**不是** finance-*）。

## 7. 页面与路由

| 路由 | 名称 | 内容 |
| --- | --- | --- |
| `/` | 经营工作台 | 首页提问入口、项目列表 |
| `/commerce-platform` | 商品运营 | 商品池（分页/排序）/品类池（top-100）/渠道（3 tier） |
| `/operations-briefing` | 经营情报 | 经营日报/类目经营榜/观察池 + 生成今日日报按钮 |
| `/skills` | Skills Market | 12 核心 skill 管理 |
| `/eval-platform` | 评测平台 | 评测运行 |
| `/ops-platform` | 运行治理 | 巡检/评分（quant.* 部分标注金融遗留） |
| `/admin`、`/account`、`/login` | 平台管理/账户/登录 | 登录凭证 admin@shopgate.local / shopgate2025 |

## 8. 日报链路（P7）

- 数据层：`retail-briefing.ts`（/summary + /categories/top + /items）
- 生成持久化：`retail-daily-report.ts` → OperationBriefRun(completed) + OperationBrief
- 路由：`GET/POST /api/commerce/briefing/daily`
- 页面：/operations-briefing daily 视图"生成今日日报"按钮 + 最近生成日报
- **推送回执**：待通知渠道配置（未接）

## 9. 评测/基准（P9）

- 零售基准：`config/evals/task-e2e-retail-v1.json`（30 零售 case，4 能力）
- 运行：`check-task-e2e-campaign.ts --dataset=task-e2e-retail-v1 [--limit=N] --campaign=<id>`
- 真实校验入口：`check-retail-e2e-benchmark.js`（数据集结构 + 最近运行证据 ready>0）
- 已验证：`--limit=1` R01 READY(svgCount3)；`--limit=4` R02/R03/R04 READY
- **金融 eval 框架**（判官校准/变异/生产回放）标注金融域遗留，待零售语料后重建

## 10. Skills（P8，12 核心 skill）

commerce-market-data、commerce-master-data、commerce-rule-review、commerce-metrics、
commerce-data-registry、commerce-entity-resolver（6 领域 skill，1.0.x）
dashboard-visualization(0.9.0)、query-rewrite(0.6.1)、run-planner(0.6.0)、
data-quality(0.5.1)、image-extraction(0.5.0)、platform-ui-product-design(0.3.2)

命名策略 scope：`quant`/`commerce`/`platform`/`workflow`/`input`/`evidence`/`visualization`
（quant-\* skill 已全部改名 commerce-\*；`.pi` 内品牌词/quant_ 工具名/finance-\* 路径 = 0）

## 11. 已删除（文档中不得作为现状描述）

- `src/lib/domains/finance/**`、`finance.quant` 域包
- `src/lib/commerce/data-prefetch.ts`、`validation.ts`、`strategies.ts`（已改名/移除）
- `src/app/strategy-platform/**`、`StrategyPlatformClient.tsx`
- `benchmarks/`（P0 删除；金融基准运行器已改零售委托）
- 金融 benchmarks 数据（cases/e2e-suite/datasets/snapshot-manifest/query-rewrite-fixtures）
- 东方财富/Baostock/ClickHouse 金融数据链路

## 12. 遗留（如实标注，不得描述为已完成）

- 改名 Skill 的 body/scripts 仍有金融计算逻辑，功能级零售化归 `ISSUE-P29`
- 判官校准/变异/生产回放缺零售语料，重建归 `ISSUE-P29`
- 当前数据集缺少用户、会话、渠道、活动、成本、利润、退款、履约和长期复购字段；数据契约与可追溯扩展归 `ISSUE-P27`
- 用户留存/RFM、渠道/活动归因、毛利利润、补货预测、生命周期和价格弹性等分析能力归 `ISSUE-P28`
- 多轮下钻、图表联动、限制说明和行动建议增强归 `ISSUE-P30`
- 日报推送回执待通知渠道
- `retail-validation.ts` 3140 行（预算警告）
- R01 类 catalog case 偶发输出 token 预算达成
- `check-skills-visual`/`check-platform-visuals` 视觉检查失败（待排查）
