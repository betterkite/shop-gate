---
name: commerce-market-data
description: Fetch and validate retail behavior, product, category, and window data through Shop Gate's local commerce-data backend.
---

# Shop Gate 经营数据取数

只负责取得窗口内可追溯的零售事实，不设计页面，也不使用示例数据替代真实数据。取数必须绑定当前 `dataset_id`。

## 执行流程

1. 用 `commerce-data-registry` 确认数据集和最小端点。
2. 读取 `/api/v1/commerce/meta`，确认时间窗口、来源、行数、字段和数据质量。
3. 按需读取 `/api/v1/commerce/analytics/overview`、`funnel`、`categories`、`inventory`、`lifecycle`、`profit`、`price-elasticity` 或 `drilldown`。
4. 商品级问题读取 `/api/v1/commerce/items/{item_id}/events`；聚合接口没有商品证据时，保留“无法下钻”的限制。
5. 收到事件或日指标后执行：

```bash
python3 scripts/validate_behavior_events.py data_file/raw/<run_id>/events.json
```

6. 将原始响应、来源、样本量、时间和缺口交给 `commerce-metrics` 与 `dashboard-visualization`。

遇到字段映射或行为事件质量问题时，读取 [behavior-data-contract.md](references/behavior-data-contract.md)。

## 质量边界

- 行为顺序应满足 PV≥收藏≥加购≥购买；不满足时标记告警，不强行修正真实数据。
- PV、UV、收藏、加购、购买和 GMV 必须注明窗口和计算口径。
- GMV 优先使用数据中的实际价格；只有明确标注合成价格时才允许称为估算。
- 数据集窗口外不生成趋势，缺少价格弹性所需的价格变化和订单量时返回数据不足。
- 不读取未登记的数据类型、外部数据源或浏览器直连接口。
