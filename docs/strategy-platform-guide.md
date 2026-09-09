# 【金融域遗留 · 已归档】策略平台使用与设计指南

> **本文档描述的是金融策略平台（策略扫描/回测/选股），这些能力已随金融域在 P3 移除，不适用于当前零售电商项目。**
>
> 零售域的对应能力是 **[商品运营（/commerce-platform 路由）](architecture.md)**（商品池/品类池/渠道分析）与四种零售看板能力；经营情报见 **[经营情报（/operations-briefing 路由）](architecture.md)** 相关页面。
> 本文档仅保留作历史参考。

---

## 历史参考摘要

**它曾经是什么。** 金融域的 Shop Gate（蓝本 QuantPilot，MIT，出处记录见 PROVENANCE.md 与 PRD 来源说明）曾提供"策略平台"页面（原 `/strategy-platform` 路由），把本地沉淀的行情 K 线、因子、A 股股票池/ETF 池、数据质量和策略规则组织在同一套事实上，支撑选股、买卖价格计划与回测。配套能力包括：策略目录（选股策略与价格策略）、因子目录（均线、相对强弱、波动、回撤、估值等）、多源行情补数（东方财富/Baostock/AKShare/ClickHouse）、交易日历与数据质量扫描等基础组件；底层数据落在 `quant.*` schema（`stock_bars`、`stock_factors`、`securities`、`security_universes` 等）。

**为何随金融域移除。** 项目定位转为零售电商 Data Agent 工作台后，金融域在 P3 整体移除：`src/lib/domains/finance/**`、`src/app/strategy-platform/**`、`StrategyPlatformClient.tsx`、回测与金融 benchmarks 数据链路均已删除。本文仅作历史参考，其中关于行情、因子、选股、回测的描述不再构成现状。

**零售域的对应能力。**

| 金融域概念（已移除） | 零售等价物（现状） |
| --- | --- |
| 股票池 / ETF 池（`quant.security_universes`） | 商品池 / 品类池（/commerce-platform 页面，读 `/items`、`/categories/top`） |
| K 线 / 行情 / 均线 | 经营趋势与行为指标（`commerce.daily_item_metrics` 的 pv/fav/cart/buy/gmv） |
| 选股策略 / 回测 | 四种零售看板能力（traffic_funnel / catalog_structure / price_inventory / daily_brief）与生成管线内的规则验证 |
| 证券主数据（`quant.securities`） | 商品主数据（`commerce.items` 等，合成口径） |
| 行情补数 / 数据覆盖 | commerce-data 数据接入（`shopgate-commerce-import` CLI、导入任务与水位表） |
| 研报 / 投研日报 | 经营日报（/operations-briefing 页面，`GET/POST /api/commerce/briefing/daily`） |

现状端点、数据表与数据接入见 [API 总览](api-reference.md)、[数据字典](data-dictionary.md) 与 [commerce-data 数据接入](commerce-data-ingestion.md)。
