# 03. 市场数据（commerce-data）与商品运营页

目标：理解 Shop Gate 如何用 commerce-data 后端管理零售行为数据与商品主数据，以及商品运营页、经营情报页如何消费这些数据，生成看板和经营日报。

历史金融"策略平台"（行情/因子/选股/回测）的设计取舍已归档，见 [策略平台使用与设计指南（已归档）](../strategy-platform-guide.md)；本文只讲零售现状。

## 数据底座

| 组件 | 责任 |
| --- | --- |
| PostgreSQL/TimescaleDB | `commerce.*` 事实库：行为事件、商品/类目主数据、日聚合、导入任务与质量扫描 |
| Redis | 跨进程短期缓存，只做加速，不作为事实库 |
| 文件系统 | 生成工作空间源码、数据文件、证据文件和大 JSON |

TimescaleDB 是 PostgreSQL 的时序扩展镜像，所以连接方式仍然是 PostgreSQL；镜像名称不同，是因为它预装了 TimescaleDB 扩展。

## 零售数据长什么样

数据源是天池淘宝 UserBehavior（dataset 649）公开镜像切片，保留原始窗口 **2017-11-25 ~ 2017-12-03**（`--time-shift none`）。行为类型只有四种：

| 行为 | 含义 | 在漏斗里的角色 |
| --- | --- | --- |
| `pv` | 曝光 | 漏斗顶：商品被看到 |
| `fav` | 收藏 | 兴趣信号 |
| `cart` | 加购 | 购买意向 |
| `buy` | 购买 | 漏斗底：成交 |

可以把这四类行为计数理解为零售域的"行情"：经营趋势都从它们聚合而来，替代金融时代的 K 线/均线。

另一个必须理解的口径是**合成主数据**：`price`/`stock`/`brand`/`shop` 为导入脚本确定性生成的合成档案（同一种子可复现），`gmv = buy 事件数 × 合成价格`。因此所有金额展示必须带"合成口径"标注——这是本项目的硬规则。

规模速览：`user_behavior_events` 1,013,367 事件 / 10,000 用户；`items` 412,130、`categories` 5,922、`brands` 200、`shops` 500；`daily_item_metrics` 687,562、`daily_category_metrics` 30,644。字段级口径见 [数据字典](../data-dictionary.md)。

## 数据怎么进来

数据导入统一走 `shopgate-commerce-import` CLI（services/commerce-data）：

```bash
shopgate-commerce-import import-userbehavior --csv <path> --users 10000 --seed 20251203 --time-shift none
```

配套子命令：`generate-synthetic-behavior`、`generate-synthetic-master`、`aggregate-daily`（生成日聚合）。

事件 CSV 契约很严格：表头必须是 5 列 `user_id,item_id,category_id,behavior_type,timestamp`（Unix 秒）。导入进度与水位记录在 provider 书签表 `commerce.market_data_ingestion_jobs` / `commerce.market_data_sync_state`。

完整命令与故障排查见 [commerce-data 数据接入](../commerce-data-ingestion.md)。

## 数据怎么读出去（commerce-data API）

commerce-data 服务（:8000）是零售域唯一取数后端，端点前缀 `GET /api/v1/commerce/`：

| 端点 | 用途 |
| --- | --- |
| `/meta` | 数据集口径：窗口、规模、真实/合成来源计数；生成管线的预取窗口动态取自这里 |
| `/resolve` | 实体解析：`item:<id>`/`cat:<id>` 显式形式 + 类目名/商品标题模糊匹配 |
| `/capabilities` | 四个零售能力的发现信息（domain_pack=`retail.core`） |
| `/funnel`、`/funnel/daily` | 全窗口/按日流量漏斗（pv→fav→cart→buy） |
| `/categories/top` | 类目经营榜（`metric` 默认 gmv，`limit` ≤100） |
| `/items` | 商品池分页：`page`/`page_size`(≤100)/`category_id`/`sort`(gmv\|pv\|buy\|price) |
| `/items/{id}/daily` | 单商品日粒度行为与 GMV |
| `/inventory-risk` | 库存风险（合成字段 price/stock） |
| `/channels` | 渠道聚合：standard/premium/flagship 三档，gmv_share ≈ 0.35/0.34/0.32 |
| `/summary?date=` | 单日经营汇总 |

`/summary?date=2017-12-03` 的参考值：GMV ¥1,198,069.97、曝光 110,710、购买 2,452、转化 2.21%、客单价 ¥488.61。核对自己环境的数据时可以用这组数字对照。

页面原则：页面不直接读原始数据集，也不把平台 API 当隐藏 mock；服务端预取结果写入生成工作空间，再由看板消费。完整清单见 [API 总览](../api-reference.md)。

## 商品运营页（/commerce-platform）

商品运营页围绕"商品/类目/渠道"三类对象组织数据：

| 区域 | 用途 |
| --- | --- |
| 商品池 | 商品分页列表，支持按 gmv/pv/buy/price 排序与类目过滤 |
| 品类池 | 类目经营榜 top-100 |
| 渠道 | 店铺 tier 三档（standard/premium/flagship）聚合对比 |

性能取舍：列表必须服务端分页（`page_size` 上限 100），不把 41 万商品一次性塞给前端；单商品趋势（`/items/{id}/daily`）按需加载。

## 经营情报页（/operations-briefing）

| 区域 | 用途 |
| --- | --- |
| 经营日报 | 证据型日报（Markdown + 结构化数据 + evidence） |
| 类目经营榜 | 当日类目经营排行 |
| 观察池 | 关注的商品/类目集合，驱动日报生成 |

日报链路：数据层 `retail-briefing.ts`（/summary + /categories/top + /items）→ `retail-daily-report.ts` 持久化为 OperationBriefRun(completed) + OperationBrief → 路由 `GET/POST /api/commerce/briefing/daily`。页面提供"生成今日日报"按钮和最近生成日报列表。

如实标注：日报推送回执待通知渠道配置，尚未接通。

## 从问题到看板（速览生成管线）

自然语言问题进入生成管线后：

```text
Query Rewrite（DeepSeek，selectedModel=deepseek-v4-flash 裸模型名）
→ Run Plan（.data-agent/retail-run-plan.json：window / capabilityId / visualization.templateId）
→ Data Prefetch（retail-data-prefetch.ts 调 commerce-data API，窗口取自 /meta）
→ 标准看板生成（writeRetailDashboardTemplate 按能力分发，多面板 SVG）
→ 自动验证 → 证据验收 → receipt → 持久预览
```

四个零售能力：`traffic_funnel`（流量漏斗）、`catalog_structure`（类目结构）、`price_inventory`（价格库存）、`daily_brief`（经营日报）。注意工作区文件是 `retail-run-plan.json` / `retail-query-rewrite.json`。

深入生成与验证看 [02. AI 工作区生成](02-ai-workspace-generation.md) 和 [04. Skills 与可视化看板](04-skills-and-visual-dashboard.md)。

## 练习

1. 启动 commerce-data 后访问 `GET /api/v1/commerce/meta`，核对窗口是否为 2017-11-25 ~ 2017-12-03。
2. 用 `/items?sort=gmv&page=1&page_size=20` 找到 GMV 最高商品，再用 `/items/{id}/daily` 看它的日趋势。
3. 在 /operations-briefing 生成一次今日日报，检查生成运行与日报记录是否落库。
