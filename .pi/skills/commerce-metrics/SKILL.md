---
name: commerce-metrics
description: Compute deterministic retail operating metrics such as funnel conversion, GMV, sell-through, stock-to-sales, lifecycle, and daily trends.
---

# Shop Gate 经营指标

把已校验的零售事件、商品和日指标转换为用户能理解的经营结果，并同时给出公式、窗口、样本量和缺口。

## 确定性脚本

```bash
python3 scripts/funnel_metrics.py data_file/raw/<run_id>/events.json
python3 scripts/inventory_health.py data_file/final/products.json
python3 scripts/retail_trend.py data_file/final/daily-metrics.json
```

## 口径

- 转化率=购买量÷浏览量；加购到购买=购买量÷加购量，分母为 0 时返回空值。
- GMV=购买量×数据中的实际成交价格；价格缺失时不反推，也不擅自使用“合成价格”。
- 库销比=库存÷窗口购买量；无购买时标记“无销量”，不能写成 0。
- 动销率、商品阶段、类目集中度和日环比都必须绑定同一窗口与同一数据集。
- PV、UV、收藏、加购、购买是不同概念；图表使用哪个指标就写清中文名和英文缩写。

公式、分母边界和缺失值规则见 [retail-metrics-methodology.md](references/retail-metrics-methodology.md)。

## 禁止事项

- 不计算收益、波动、回撤、相关性、流动性或技术指标。
- 不把窗口内事件外推成窗口外趋势。
- 不在样本不足时给出确定性判断。
