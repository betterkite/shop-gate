---
name: commerce-metrics
description: Use for paid-order amounts, refunds, costs or event conversion. Select the accounting guide for the current BI module.
---

# Shop Gate 经营指标

查询经营账本时，从[八个模块的口径说明](assets/ledger-methods.json)选当前模块。问定义时查指标目录；问实际金额或排名时读取当前授权范围和数据版本的账本依据。行为数据可回答浏览、加购和购买事件问题。

## 确定性脚本

```bash
python3 scripts/funnel_metrics.py data_file/raw/<run_id>/events.json
python3 scripts/inventory_health.py data_file/final/products.json
python3 scripts/retail_trend.py data_file/final/daily-metrics.json
```

## 口径

- 转化率=购买量÷浏览量；加购到购买=购买量÷加购量，分母为 0 时返回空值。
- 成交总额（GMV）来自已付款订单明细实收金额。仅有行为数据时，说明缺少订单金额。
- 库销比=库存÷窗口购买量；无购买时标记“无销量”，不能写成 0。
- 动销率、商品阶段、类目集中度和日环比都必须绑定同一窗口与同一数据集。
- PV、UV、收藏、加购、购买是不同概念；图表使用哪个指标就写清中文名和英文缩写。

公式、分母边界和缺失值规则见 [retail-metrics-methodology.md](references/retail-metrics-methodology.md)。

## 禁止事项

- 不计算收益、波动、回撤、相关性、流动性或技术指标。
- 不把窗口内事件外推成窗口外趋势。
- 不在样本不足时给出确定性判断。
