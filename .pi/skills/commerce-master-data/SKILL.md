---
name: commerce-master-data
description: Describe retail product and category master data, price, stock, attributes, and the source boundary of synthetic fields.
---

# Shop Gate 商品主数据

组织商品、类目、价格、库存、渠道、活动和用户维度，供经营分析和看板使用。

## 执行流程

1. 先确认当前 `dataset_id` 和窗口，再读取商品/类目主数据。
2. 保留 `item_id`、名称、类目、价格、库存、属性、来源和更新时间。
3. 区分实际字段与合成字段；合成字段必须在页面和 evidence 中明示，不能伪装成真实业务事实。
4. 需要商品阶段或分层时运行：

```bash
python3 scripts/product_segments.py data_file/final/dashboard-data.json
```

5. 价格弹性只在存在多个价格点与可比较购买量时计算；否则输出数据不足和需要补充的字段。

主数据字段和合成数据边界见 [master-data-contract.md](references/master-data-contract.md)。

## 禁止事项

- 不读取财报、公告、EPS、PE、估值或投资组合。
- 不用估算价格覆盖真实价格。
- 不把库存关注数直接解释为必须补货；应同时呈现库存、销量、浏览和购买转化。
